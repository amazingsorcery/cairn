import { z } from "zod";

import { ForbiddenError, UnauthenticatedError } from "@/lib/auth";
import { logger } from "@/lib/logger";

/**
 * The Server Action return contract.
 *
 * Actions RETURN failures rather than throwing them. A thrown error in a Server Action
 * reaches the client as a generic "An error occurred in the Server Components render" with
 * the message stripped in production, which is correct for an unexpected error and useless
 * for "that slug is already taken". So expected failures are values with a field path, and
 * only genuinely unexpected ones throw.
 *
 * `fieldErrors` is keyed by the same path Zod produces, so a form can attach a message to
 * the input that caused it without a translation layer.
 */
export type ActionSuccess<T> = { ok: true; data: T };
export type ActionFailure = {
  ok: false;
  /** One sentence, safe to render. Never contains a database error or a stack. */
  message: string;
  fieldErrors?: Record<string, string[]>;
  /** Distinguishes the cases a form must handle differently. */
  code: "validation" | "unauthenticated" | "forbidden" | "notFound" | "conflict" | "unexpected";
};
export type ActionResult<T> = ActionSuccess<T> | ActionFailure;

export function ok<T>(data: T): ActionSuccess<T> {
  return { ok: true, data };
}

export function fail(
  code: ActionFailure["code"],
  message: string,
  fieldErrors?: Record<string, string[]>,
): ActionFailure {
  return fieldErrors ? { ok: false, code, message, fieldErrors } : { ok: false, code, message };
}

export function fromZodError(error: z.ZodError): ActionFailure {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_";
    (fieldErrors[path] ??= []).push(issue.message);
  }
  return fail("validation", "Some fields need attention.", fieldErrors);
}

/**
 * Postgres error codes and constraint names, mapped to sentences an editor can act on.
 *
 * HANDOFF §3: "The name appears in the Postgres error, so map them to friendly messages in
 * the form layer." This is that map. An unmapped constraint falls through to a generic
 * message and a logged error — better a vague sentence than a raw `23514` quoting internal
 * SQL at a user.
 */
const CONSTRAINT_MESSAGES: Readonly<Record<string, string>> = {
  tools_slug_key: "That slug is already used by another tool.",
  playbooks_slug_key: "That slug is already used by another playbook.",
  categories_slug_key: "That slug is already used by another category.",
  tags_slug_key: "That slug is already used by another tag.",
  cameras_slug_key: "That slug is already used by another camera.",
  connectors_slug_key: "That slug is already used by another connector.",
  users_email_key: "An account already exists for that address.",

  tools_published_requires_verification_check:
    "A tool cannot be published without a verification date and a reliability rating (ADR 0007).",
  playbooks_published_requires_verification_check:
    "A playbook cannot be published without a verification date (ADR 0007).",
  cameras_published_requires_verification_check:
    "A camera cannot be published without a verification date and a note on why embedding is or is not permitted.",
  connectors_published_requires_legal_basis_check:
    "A connector cannot be published without a terms URL, a recorded legal basis and a check date (ADR 0012).",
  connectors_attribution_check:
    "State the attribution this source requires, or mark attribution as not required.",
  connectors_api_key_env_var_check:
    "Name the environment variable holding the credential — never the credential itself.",
  connectors_quota_check:
    "The global ceiling must be at least the per-user quota, and both windows must be positive.",
  cameras_embed_requires_connector_check:
    "A published camera that embeds a feed must be attached to a connector, because embedding needs a recorded legal basis.",
  cameras_embed_url_check: "An embedded camera needs an embed URL.",

  tools_reliability_range_check: "Reliability is a whole number from 1 to 5.",
  playbooks_estimated_minutes_check: "Estimated time must be more than zero minutes.",
  playbook_steps_playbook_order_uniq:
    "Two steps ended up with the same position. Reordering must run in one transaction.",
  workspace_items_tool_unique_idx: "That tool is already saved in this workspace.",
  workspace_items_step_unique_idx: "That step is already on this checklist.",
};

type PgError = { code?: string; constraint?: string; detail?: string };

function asPgError(error: unknown): PgError | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as PgError;
  return typeof candidate.code === "string" ? candidate : null;
}

/**
 * Wrap an action body. Turns the four expected failure shapes into values and lets anything
 * else through as an unexpected failure — logged with the error, returned without it.
 *
 * The user never sees a database message. `detail` on a unique violation contains the
 * conflicting VALUE, which for `users_email_key` is somebody's email address.
 */
export async function guard<T>(
  scope: string,
  body: () => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return fail("unauthenticated", "Sign in to continue.");
    }
    if (error instanceof ForbiddenError) {
      return fail("forbidden", "You do not have permission to do that.");
    }
    if (error instanceof z.ZodError) {
      return fromZodError(error);
    }

    const pg = asPgError(error);
    if (pg) {
      const known = pg.constraint ? CONSTRAINT_MESSAGES[pg.constraint] : undefined;
      if (known) {
        logger.warn({ scope, constraint: pg.constraint, code: pg.code }, "Constraint violation");
        return fail("conflict", known);
      }
      if (pg.code === "23503") {
        logger.warn({ scope, constraint: pg.constraint }, "Foreign key violation");
        return fail(
          "conflict",
          "Something still references this record, so it cannot be removed. Move or delete the dependent entries first.",
        );
      }
      // `detail` is deliberately not logged: on a unique violation it contains the
      // conflicting value, which for users_email_key is somebody's address.
      logger.error({ scope, code: pg.code, constraint: pg.constraint }, "Database error");
      return fail("unexpected", "That could not be saved. Nothing was changed.");
    }

    logger.error({ scope, err: error }, "Unexpected action failure");
    return fail("unexpected", "Something went wrong. Nothing was changed.");
  }
}
