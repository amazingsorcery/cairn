"use server";

import { revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";

import { cameras, connectors } from "@/db/schema";
import { requireAdmin, requireEditor } from "@/lib/auth";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { TAG } from "@/lib/queries/cache";
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
 * Live registry mutations.
 *
 * Connectors are ADMIN-only, not editor (sitemap.md §8): they carry the kill-switch, the
 * quota envelope and the recorded legal basis, which are operator responsibilities rather
 * than editorial ones. Cameras are ordinary editorial work at `editor` level — a camera is
 * content, held to the same standard as a tool.
 */

/**
 * The kill-switch. ADR 0011 rule 6: "a source that changes its terms can be disabled without
 * a deploy".
 *
 * It is deliberately the smallest possible action — one boolean, no other field — so that
 * turning a connector off at 3am cannot fail validation on some unrelated field an operator
 * has not filled in. That is the whole point of a kill-switch.
 *
 * It does NOT touch `status`. ADR 0012 §1: the two axes must not be merged, so re-publishing
 * cannot silently re-enable something an operator switched off.
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

    // Loud, because an operator will want this line in the log during an incident. The
    // actor is a user id, not an address.
    logger.warn(
      { scope: "connector.enabled", slug: row.slug, enabled: parsed.data.enabled, by: user.id },
      parsed.data.enabled ? "Connector ENABLED" : "Connector DISABLED (kill-switch)",
    );

    // `getLiveConnector` is deliberately uncached, so the switch takes effect on the next
    // request with no TTL in between. The `/live` landing page's connector list is cached
    // and does need purging.
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
      // `lastCheckedAt` is absent: like `lastVerifiedAt` on a tool, it moves only on the
      // explicit "terms re-read" action, never as a side effect of an edit (ADR 0007 §8
      // applied to connectors by ADR 0012's consequences).
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
 * Publish a connector.
 *
 * `connectors_published_requires_legal_basis_check` is the enforcement; this Zod gate exists
 * so the operator is told WHICH of the three is missing rather than being shown a constraint
 * name. ADR 0012: "the constraint fails at write time, in front of the person who caused it".
 *
 * Publishing does NOT enable. Fail closed (ADR 0012 §1).
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

/**
 * "Terms re-read." The connector equivalent of ADR 0007 §8's re-verify: the date is `now()`,
 * never supplied, because the claim is that a human read the terms now.
 *
 * ADR 0012: "a connector whose terms were last read fourteen months ago is a live legal
 * risk, and the only thing that makes that visible is a queue someone looks at" — this is
 * how a row leaves `/admin/queue`.
 */
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
      // No `lastVerifiedAt`: a save never moves it (ADR 0007 §8).
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

    /**
     * No hand-written gate here: `cameras_published_requires_verification_check` and
     * `cameras_embed_requires_connector_check` will reject the UPDATE, and `guard` maps both
     * constraint names to a sentence. This is the one place where letting the constraint be
     * the primary check is right — the two conditions are compound and the constraint states
     * them once, correctly, for every write path including the seed.
     */
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
      // `published_at` is not cleared, as on tools and playbooks (HANDOFF §4).
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

/** "Confirm still accurate" for a camera. The date is `now()` (ADR 0007 §8). */
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
