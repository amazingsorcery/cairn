import { randomUUID } from "node:crypto";

import { asc, inArray } from "drizzle-orm";
import { describe, expect, inject, it } from "vitest";

import {
  categories,
  notes,
  playbookSteps,
  playbooks,
  tools,
  users,
  workspaceFeatureSnapshots,
  workspaceItems,
  workspaces,
  type UserRole,
} from "@/db/schema";
import { db } from "@/lib/db";

/**
 * Shared fixtures for the database-backed suites.
 *
 * Nothing is truncated between tests: every fixture uses random identifiers, so files can run
 * in parallel against one database. Fixture content is synthetic, never real tools.
 */

const availability = inject("postgres");

/** True when `tests/global-setup.ts` prepared a database this run may write to. */
export const postgresAvailable = availability.available;
export const postgresUnavailableReason = availability.available ? "" : availability.reason;

/**
 * `describe` for a suite that needs Postgres. Skips locally without a database; CI fails
 * instead via `requireDatabaseOrFailInCI`.
 */
export const describeWithDatabase = postgresAvailable ? describe : describe.skip;

/**
 * Call at the top level of the test file, not inside `describeWithDatabase`, or it gets
 * skipped along with the suite. Registers its own never-skipped `describe`.
 */
export function requireDatabaseOrFailInCI(suiteName: string): void {
  describe(`${suiteName} — preconditions`, () => {
    it("has a real database to test against (mandatory in CI)", () => {
      if (process.env.CI) {
        expect(postgresAvailable, postgresUnavailableReason).toBe(true);
      }
      // Locally, require a real reason so the output says why the suite skipped.
      expect(postgresAvailable || postgresUnavailableReason.length > 10).toBe(true);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Actors
 * ------------------------------------------------------------------ */

export type Actor = { readonly id: string; readonly email: string; readonly role: UserRole };

/** A signed-in user with a random `.invalid` address. */
export async function createActor(role: UserRole = "user"): Promise<Actor> {
  const email = `case-owner-${randomUUID()}@example.invalid`;
  const inserted = await db.insert(users).values({ email, role }).returning({ id: users.id });
  const row = inserted[0];
  if (!row) throw new Error("fixture: user insert returned nothing");
  return { id: row.id, email, role };
}

/* ------------------------------------------------------------------ *
 * Catalogue — the editorial rows a case file points at
 * ------------------------------------------------------------------ */

export type Catalogue = {
  readonly categoryId: string;
  /** Published: may be saved into a workspace. */
  readonly toolId: string;
  readonly toolName: string;
  readonly toolSlug: string;
  /** A second published tool, for a successful save into a case that already has `toolId`. */
  readonly secondToolId: string;
  readonly secondToolName: string;
  /** Draft: must NOT be saveable, or a guessed uuid pulls unpublished work into a case. */
  readonly draftToolId: string;
  readonly publishedPlaybookId: string;
  readonly publishedStepIds: readonly string[];
  readonly publishedStepTitles: readonly string[];
  /** Draft playbook and its step, for the same reason as `draftToolId`. */
  readonly draftPlaybookId: string;
  readonly draftStepId: string;
};

async function insertPlaybook(
  categoryId: string,
  status: "draft" | "published",
  stepTitles: readonly string[],
): Promise<{ id: string; stepIds: string[] }> {
  const suffix = randomUUID();
  const inserted = await db
    .insert(playbooks)
    .values({
      slug: `fixture-playbook-${suffix}`,
      title: `Fixture playbook ${suffix.slice(0, 8)}`,
      summary: "A fixture playbook used only by the automated tests.",
      categoryId,
      difficulty: "beginner",
      estimatedMinutes: 30,
      status,
      // Required by the published CHECK.
      lastVerifiedAt: status === "published" ? new Date() : null,
      confidence: "needsReview",
    })
    .returning({ id: playbooks.id });
  const playbook = inserted[0];
  if (!playbook) throw new Error("fixture: playbook insert returned nothing");

  const steps = await db
    .insert(playbookSteps)
    .values(
      stepTitles.map((title, index) => ({
        playbookId: playbook.id,
        orderIndex: index,
        title,
        objective: "Fixture objective.",
        body: "Fixture body.",
        doneWhen: "The fixture has served its purpose.",
      })),
    )
    .returning({ id: playbookSteps.id });

  return { id: playbook.id, stepIds: steps.map((step) => step.id) };
}

/** One category, one published and one draft tool, one published and one draft playbook. */
export async function createCatalogue(): Promise<Catalogue> {
  const suffix = randomUUID();
  const categoryRows = await db
    .insert(categories)
    .values({
      slug: `fixture-category-${suffix}`,
      name: `Fixture category ${suffix.slice(0, 8)}`,
    })
    .returning({ id: categories.id });
  const category = categoryRows[0];
  if (!category) throw new Error("fixture: category insert returned nothing");

  const insertTool = async (
    label: string,
    status: "draft" | "published",
  ): Promise<{ id: string; name: string; slug: string }> => {
    const slug = `fixture-${label}-${suffix}`;
    const name = `Fixture ${label} ${suffix.slice(0, 8)}`;
    const rows = await db
      .insert(tools)
      .values({
        slug,
        name,
        url: `https://example.invalid/${label}`,
        summary: "A fixture tool used only by the automated tests.",
        description: "Not a catalogue entry. Created and read by the test suite alone.",
        categoryId: category.id,
        costModel: "free",
        status,
        // Both required by the published CHECK.
        lastVerifiedAt: status === "published" ? new Date() : null,
        reliability: status === "published" ? 3 : null,
        confidence: "needsReview",
      })
      .returning({ id: tools.id });
    const row = rows[0];
    if (!row) throw new Error("fixture: tool insert returned nothing");
    return { id: row.id, name, slug };
  };

  const publishedTool = await insertTool("tool", "published");
  const secondTool = await insertTool("second-tool", "published");
  const draftTool = await insertTool("draft-tool", "draft");
  const toolSlug = publishedTool.slug;
  const toolName = publishedTool.name;

  const publishedStepTitles = ["Fixture step one", "Fixture step two", "Fixture step three"];
  const published = await insertPlaybook(category.id, "published", publishedStepTitles);
  const draft = await insertPlaybook(category.id, "draft", ["Fixture draft step"]);
  const draftStepId = draft.stepIds[0];
  if (!draftStepId) throw new Error("fixture: draft step insert returned nothing");

  return {
    categoryId: category.id,
    toolId: publishedTool.id,
    toolName,
    toolSlug,
    secondToolId: secondTool.id,
    secondToolName: secondTool.name,
    draftToolId: draftTool.id,
    publishedPlaybookId: published.id,
    publishedStepIds: published.stepIds,
    publishedStepTitles,
    draftPlaybookId: draft.id,
    draftStepId,
  };
}

/* ------------------------------------------------------------------ *
 * Case files
 * ------------------------------------------------------------------ */

export type CaseFile = {
  readonly workspaceId: string;
  readonly title: string;
  readonly checklistItemId: string;
  readonly checklistItemIds: readonly string[];
  readonly toolItemId: string;
  readonly featureItemId: string;
  readonly featureRef: string;
  readonly noteId: string;
  readonly noteBody: string;
};

/**
 * A populated case file belonging to `ownerId`: a checklist derived from the playbook, a
 * saved tool, a saved map feature with its snapshot, and one note.
 *
 * Direct inserts, so a broken action can't produce a fixture that makes tests vacuous.
 */
export async function createCaseFile(
  ownerId: string,
  catalogue: Catalogue,
  titlePrefix = "Case",
): Promise<CaseFile> {
  const suffix = randomUUID();
  const title = `${titlePrefix} ${suffix.slice(0, 8)}`;

  const workspaceRows = await db
    .insert(workspaces)
    .values({ userId: ownerId, title, playbookId: catalogue.publishedPlaybookId })
    .returning({ id: workspaces.id });
  const workspace = workspaceRows[0];
  if (!workspace) throw new Error("fixture: workspace insert returned nothing");

  const checklistRows = await db
    .insert(workspaceItems)
    .values(
      catalogue.publishedStepIds.map((stepId, index) => ({
        workspaceId: workspace.id,
        userId: ownerId,
        kind: "checklistStep" as const,
        stepId,
        title: catalogue.publishedStepTitles[index] ?? `Fixture step ${index}`,
        orderIndex: index,
      })),
    )
    .returning({ id: workspaceItems.id });

  const toolItemRows = await db
    .insert(workspaceItems)
    .values({
      workspaceId: workspace.id,
      userId: ownerId,
      kind: "tool",
      toolId: catalogue.toolId,
      title: catalogue.toolName,
      orderIndex: 0,
    })
    .returning({ id: workspaceItems.id });

  const featureRef = `fixture-feature-${suffix}`;
  const featureItemRows = await db
    .insert(workspaceItems)
    .values({
      workspaceId: workspace.id,
      userId: ownerId,
      kind: "mapFeature",
      title: "Fixture observation",
      orderIndex: 0,
    })
    .returning({ id: workspaceItems.id });

  const checklistItemId = checklistRows[0]?.id;
  const toolItemId = toolItemRows[0]?.id;
  const featureItemId = featureItemRows[0]?.id;
  if (!checklistItemId || !toolItemId || !featureItemId) {
    throw new Error("fixture: workspace item insert returned nothing");
  }

  await db.insert(workspaceFeatureSnapshots).values({
    workspaceItemId: featureItemId,
    workspaceId: workspace.id,
    userId: ownerId,
    sourceSlug: "fixture-source",
    sourceName: "Fixture source",
    sourceKind: "infrastructure",
    featureRef,
    latitude: 51.5,
    longitude: -0.1,
    altitudeMetres: null,
    observedAt: new Date("2026-01-01T12:00:00.000Z"),
    sourceUrl: null,
    attribution: "Fixture attribution",
    licence: "Fixture licence",
    properties: {},
  });

  const noteBody = `Fixture note body ${suffix}`;
  const noteRows = await db
    .insert(notes)
    .values({ workspaceId: workspace.id, userId: ownerId, body: noteBody })
    .returning({ id: notes.id });
  const note = noteRows[0];
  if (!note) throw new Error("fixture: note insert returned nothing");

  return {
    workspaceId: workspace.id,
    title,
    checklistItemId,
    checklistItemIds: checklistRows.map((row) => row.id),
    toolItemId,
    featureItemId,
    featureRef,
    noteId: note.id,
    noteBody,
  };
}

/** A uuid that is well-formed and belongs to nobody, for "does not exist" assertions. */
export function unknownId(): string {
  return randomUUID();
}

/* ------------------------------------------------------------------ *
 * "Nothing changed"
 * ------------------------------------------------------------------ */

export type CaseDump = {
  workspaces: { id: string; userId: string; title: string; status: string }[];
  items: {
    id: string;
    workspaceId: string;
    userId: string;
    kind: string;
    title: string;
    checked: boolean;
    orderIndex: number;
  }[];
  notes: { id: string; workspaceId: string; userId: string; body: string }[];
  snapshots: { workspaceItemId: string; userId: string; featureRef: string }[];
};

/**
 * Everything these users own, in a stable order. Compare before/after a refused mutation to
 * catch partial writes, including into the other user's rows. Timestamps are excluded since
 * `$onUpdate` moves them on any write.
 */
export async function dumpCases(userIds: readonly string[]): Promise<CaseDump> {
  const [workspaceRows, itemRows, noteRows, snapshotRows] = await Promise.all([
    db
      .select({
        id: workspaces.id,
        userId: workspaces.userId,
        title: workspaces.title,
        status: workspaces.status,
      })
      .from(workspaces)
      .where(inArray(workspaces.userId, [...userIds]))
      .orderBy(asc(workspaces.id)),
    db
      .select({
        id: workspaceItems.id,
        workspaceId: workspaceItems.workspaceId,
        userId: workspaceItems.userId,
        kind: workspaceItems.kind,
        title: workspaceItems.title,
        checked: workspaceItems.checked,
        orderIndex: workspaceItems.orderIndex,
      })
      .from(workspaceItems)
      .where(inArray(workspaceItems.userId, [...userIds]))
      .orderBy(asc(workspaceItems.id)),
    db
      .select({
        id: notes.id,
        workspaceId: notes.workspaceId,
        userId: notes.userId,
        body: notes.body,
      })
      .from(notes)
      .where(inArray(notes.userId, [...userIds]))
      .orderBy(asc(notes.id)),
    db
      .select({
        workspaceItemId: workspaceFeatureSnapshots.workspaceItemId,
        userId: workspaceFeatureSnapshots.userId,
        featureRef: workspaceFeatureSnapshots.featureRef,
      })
      .from(workspaceFeatureSnapshots)
      .where(inArray(workspaceFeatureSnapshots.userId, [...userIds]))
      .orderBy(asc(workspaceFeatureSnapshots.workspaceItemId)),
  ]);

  return {
    workspaces: workspaceRows,
    items: itemRows,
    notes: noteRows,
    snapshots: snapshotRows,
  };
}
