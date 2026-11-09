"use server";

import { revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";

import { cameras, connectors } from "@/db/schema";
import { requireAdmin, requireEditor } from "@/lib/auth";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { TAG } from "@/lib/queries/cache";
import { clearRefusalMemo } from "@/lib/connectors/runtime";
import { resetGovernanceMemo } from "@/lib/sources/governed";
import {
  cameraIdSchema,
  connectorIdSchema,
  publishConnectorSchema,
  setConnectorEnabledSchema,
  updateCameraSchema,
  updateConnectorSchema,
} from "@/lib/validation/connectors";
import { fail, fromZodError, guard, ok, type ActionResult } from "./result";

/**
 * Live registry mutations. Connectors are admin-only (kill-switch, quotas, legal basis);
 * cameras are editorial content at `editor` level.
 */

/**
 * Kill-switch: disables a source without a deploy. Takes only a boolean so it can't fail on
 * unrelated validation, and never touches `status`.
 */
export async function setConnectorEnabled(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("connector.enabled", async () => {
    const user = await requireAdmin();

    const parsed = setConnectorEnabledSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const updated = await db
      .update(connectors)
      .set({ enabled: parsed.data.enabled, updatedById: user.id })
      .where(eq(connectors.id, parsed.data.id))
      .returning({ id: connectors.id, slug: connectors.slug });

    const row = updated[0];
    if (!row) return fail("notFound", "That connector does not exist.");

    // Logged at warn for incident visibility; actor is a user id, not an address.
    logger.warn(
      { scope: "connector.enabled", slug: row.slug, enabled: parsed.data.enabled, by: user.id },
      parsed.data.enabled ? "Connector ENABLED" : "Connector DISABLED (kill-switch)",
    );

    // The registry read is uncached, so disabling is immediate. Re-enabling must clear the
    // refusal memos in this process (other processes wait up to `MAX_REFUSAL_MEMO_SECONDS`):
    // `governed.ts` for map adapters, `runtime.ts` for the Toolbench and `/live/flights`.
    resetGovernanceMemo();
    clearRefusalMemo();
    // The `/live` landing page's connector list is cached and does need purging.
    revalidateTag(TAG.connectors);

    return ok({ id: row.id });
  });
}

export async function updateConnector(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("connector.update", async () => {
    const user = await requireAdmin();

    const parsed = updateConnectorSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const { id, ...fields } = parsed.data;

    const updated = await db
      .update(connectors)
      // `lastCheckedAt` only moves via `recheckConnector`, never as a side effect of an edit.
      .set({ ...fields, updatedById: user.id })
      .where(eq(connectors.id, id))
      .returning({ id: connectors.id });

    const row = updated[0];
    if (!row) return fail("notFound", "That connector does not exist.");

    revalidateTag(TAG.connectors);
    return ok({ id: row.id });
  });
}

/**
 * Publish a connector. The DB constraint enforces the legal-basis fields; the Zod gate says
 * which one is missing. Publishing does not enable.
 */
export async function publishConnector(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("connector.publish", async () => {
    const user = await requireAdmin();

    const parsed = connectorIdSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          id: connectors.id,
          termsUrl: connectors.termsUrl,
          legalBasis: connectors.legalBasis,
          lastCheckedAt: connectors.lastCheckedAt,
        })
        .from(connectors)
        .where(eq(connectors.id, parsed.data.id))
        .limit(1);

      if (!current) return { kind: "notFound" as const };

      const gate = publishConnectorSchema.safeParse(current);
      if (!gate.success) return { kind: "gate" as const, error: gate.error };

      await tx
        .update(connectors)
        .set({ status: "published", updatedById: user.id })
        .where(eq(connectors.id, current.id));

      return { kind: "ok" as const, id: current.id };
    });

    if (result.kind === "notFound") return fail("notFound", "That connector does not exist.");
    if (result.kind === "gate") return fromZodError(result.error);

    revalidateTag(TAG.connectors);
    return ok({ id: result.id });
  });
}

/** "Terms re-read": sets `lastCheckedAt` to `now()`, removing the row from `/admin/queue`. */
export async function recheckConnector(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("connector.recheck", async () => {
    const user = await requireAdmin();

    const parsed = connectorIdSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const updated = await db
      .update(connectors)
      .set({ lastCheckedAt: new Date(), updatedById: user.id })
      .where(eq(connectors.id, parsed.data.id))
      .returning({ id: connectors.id });

    const row = updated[0];
    if (!row) return fail("notFound", "That connector does not exist.");

    revalidateTag(TAG.connectors);
    return ok({ id: row.id });
  });
}

/* ------------------------------------------------------------------ *
 * Cameras — editorial
 * ------------------------------------------------------------------ */

export async function updateCamera(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("camera.update", async () => {
    const user = await requireEditor();

    const parsed = updateCameraSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const { id, ...fields } = parsed.data;

    const updated = await db
      .update(cameras)
      // No `lastVerifiedAt`: a save never moves it.
      .set({ ...fields, updatedById: user.id })
      .where(eq(cameras.id, id))
      .returning({ id: cameras.id, slug: cameras.slug, status: cameras.status });

    const row = updated[0];
    if (!row) return fail("notFound", "That camera does not exist.");

    if (row.status === "published") {
      revalidateTag(TAG.cameras);
      revalidateTag(TAG.camera(row.slug));
    }

    return ok({ id: row.id });
  });
}

export async function publishCamera(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("camera.publish", async () => {
    const user = await requireEditor();

    const parsed = cameraIdSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    // No Zod gate: the DB constraints reject the UPDATE and `guard` maps them to messages.
    const [current] = await db
      .select({ publishedAt: cameras.publishedAt })
      .from(cameras)
      .where(eq(cameras.id, parsed.data.id))
      .limit(1);

    if (!current) return fail("notFound", "That camera does not exist.");

    const updated = await db
      .update(cameras)
      .set({
        status: "published",
        publishedAt: current.publishedAt ?? new Date(),
        updatedById: user.id,
      })
      .where(eq(cameras.id, parsed.data.id))
      .returning({ id: cameras.id, slug: cameras.slug });

    const row = updated[0];
    if (!row) return fail("notFound", "That camera does not exist.");

    revalidateTag(TAG.cameras);
    revalidateTag(TAG.camera(row.slug));
    return ok({ id: row.id });
  });
}

export async function unpublishCamera(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("camera.unpublish", async () => {
    const user = await requireEditor();

    const parsed = cameraIdSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const updated = await db
      .update(cameras)
      // `published_at` is not cleared, as on tools and playbooks.
      .set({ status: "draft", updatedById: user.id })
      .where(eq(cameras.id, parsed.data.id))
      .returning({ id: cameras.id, slug: cameras.slug });

    const row = updated[0];
    if (!row) return fail("notFound", "That camera does not exist.");

    revalidateTag(TAG.cameras);
    revalidateTag(TAG.camera(row.slug));
    return ok({ id: row.id });
  });
}

/** "Confirm still accurate" for a camera. The date is `now()`. */
export async function reverifyCamera(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("camera.reverify", async () => {
    const user = await requireEditor();

    const parsed = cameraIdSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const updated = await db
      .update(cameras)
      .set({ lastVerifiedAt: new Date(), updatedById: user.id })
      .where(eq(cameras.id, parsed.data.id))
      .returning({ id: cameras.id, slug: cameras.slug, status: cameras.status });

    const row = updated[0];
    if (!row) return fail("notFound", "That camera does not exist.");

    if (row.status === "published") {
      revalidateTag(TAG.cameras);
      revalidateTag(TAG.camera(row.slug));
    }

    return ok({ id: row.id });
  });
}
