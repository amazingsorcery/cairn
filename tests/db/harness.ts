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
 * The shared fixtures for the database-backed suites.
 *
 * NOTHING HERE IS TRUNCATED BETWEEN TESTS. Every fixture is created fresh with a random
 * identifier, so tests are isolated by construction rather than by a global reset — which is
 * what lets Vitest keep running files in parallel workers against one database. It also means
 * a test can never pass because a previous test happened to leave the right rows behind.
 *
 * FIXTURE CONTENT IS DELIBERATELY SYNTHETIC. The catalogue this product ships describes real
 * tools and is authored in `content/` (product-brief §6). These rows are not catalogue: they
 * exist to give an ownership check something to own, they never reach a shipped path, and
 * naming a real tool here would put an unverified claim about it in the repository.
 */

const availability = inject("postgres");

/** True when `tests/global-setup.ts` prepared a database this run may write to. */
export const postgresAvailable = availability.available;
export const postgresUnavailableReason = availability.available ? "" : availability.reason;

/**
 * `describe` for a suite that needs Postgres.
 *
 * It SKIPS on a machine with no database and FAILS in CI, via `assertPostgresInCI` below.
 * Silent skipping is how a security suite comes to report green while testing nothing, which
 * is the failure mode QA has already found twice in this repository.
 */
export const describeWithDatabase = postgresAvailable ? describe : describe.skip;

/**
 * CALL THIS AT THE TOP LEVEL OF THE TEST FILE, NOT INSIDE `describeWithDatabase`.
 *
 * That is not a style preference, it is the whole point, and the first version of this
 * function got it wrong. Registered inside the suite, it is skipped along with the suite —
 * so on a run with no database, the check that a database is mandatory in CI was itself
 * skipped, and 44 authorisation tests reported as a clean skip in a pipeline that should have
 * gone red. A guard inside the thing it guards is not a guard. Caught by running the suite
 * with `CI=true` and an unreachable `DATABASE_URL` and watching it pass.
 *
 * It registers its own never-skipped `describe`, so the assertion runs whatever happens to
 * the suite beside it.
 */
export function requireDatabaseOrFailInCI(suiteName: string): void {
  describe(`${suiteName} — preconditions`, () => {
    it("has a real database to test against (mandatory in CI)", () => {
      if (process.env.CI) {
        expect(postgresAvailable, postgresUnavailableReason).toBe(true);
      }
      // Locally an absent database is tolerated, but the reason must be a real sentence
      // rather than an empty string, so the output says why the suite skipped.
      expect(postgresAvailable || postgresUnavailableReason.length > 10).toBe(true);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Actors
 * ------------------------------------------------------------------ */

export type Actor = { readonly id: string; readonly email: string; readonly role: UserRole };

/**
 * A signed-in person. Addresses are random and use the reserved `.invalid` TLD, so nothing
 * here can ever be delivered to or confused with a real address.
 */
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
  /**
   * A second published tool. `workspace_items_tool_unique_idx` allows one save per tool per
   * workspace, so a fixture whose case has already saved `toolId` needs a different tool to
   * exercise a *successful* save.
   */
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
      // The published CHECK constraint requires a verification date. `new Date()` is honest
      // here: this row was created by this test run, at this instant.
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
        // The published CHECK constraint requires both of these (ADR 0007).
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
 * Written with direct inserts rather than by calling the actions, so a broken action cannot
 * quietly produce a fixture that makes the next assertion vacuous.
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
 * Everything these users own, in a stable order.
 *
 * A refused mutation is asserted by comparing this before and after. Checking only the field
 * the action would have written is weaker than it looks: `reorderWorkspaceItems` rewrites a
 * whole list, `deleteWorkspace` cascades to items, notes and snapshots, and
 * `addWorkspaceItem` writes two tables in one transaction. Comparing the whole picture
 * catches a refusal that still left something behind — including in the *other* user's rows,
 * which is where a partially-applied cross-tenant write would land.
 *
 * Timestamps are excluded deliberately: `$onUpdate` moves `updated_at` on any write, so
 * including it would make this assert "no write happened" twice over while making a legitimate
 * unrelated write look like a breach.
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
