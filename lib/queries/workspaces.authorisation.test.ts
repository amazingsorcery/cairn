import { readFileSync } from "node:fs";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { notes, tools, workspaceItems, workspaces } from "@/db/schema";
import { closeDb, db, pool } from "@/lib/db";
import * as workspaceQueries from "@/lib/queries/workspaces";
import {
  requireDatabaseOrFailInCI,
  createActor,
  createCaseFile,
  createCatalogue,
  describeWithDatabase,
  unknownId,
  type Actor,
  type Catalogue,
  type CaseFile,
} from "@/tests/db/harness";

/**
 * `lib/queries/workspaces.ts` against a real PostgreSQL. A read that takes a `userId` but
 * doesn't filter on it is an IDOR, so each query is run as the owner and as a second real
 * user with their own case file.
 *
 * The table is derived from the module's exports and parameter lists, so new queries must be
 * classified, and any taking a `userId` must be proven to filter on it.
 */

const SOURCE = readFileSync(join(process.cwd(), "lib", "queries", "workspaces.ts"), "utf8");

/** Exported function names, read off the module object at run time. */
const exportedQueryNames = Object.entries(workspaceQueries)
  .filter(([, value]) => typeof value === "function")
  .map(([name]) => name)
  .sort();

/** Exported functions taking a `userId`, read from source (param names aren't reliable at runtime). */
const userScopedInSource = [...SOURCE.matchAll(/export async function (\w+)\(([\s\S]*?)\):/g)]
  .filter(([, , params]) => /\buserId\s*:\s*string\b/.test(params ?? ""))
  .map(([, name]) => name as string)
  .sort();

type World = {
  owner: Actor;
  stranger: Actor;
  catalogue: Catalogue;
  ownersCase: CaseFile;
  strangersCase: CaseFile;
};

/**
 * One classified query: the ids it discloses must never include the owner's `secret`.
 * (Not an emptiness check, since strangers have their own rows.) No "throws" outcome: these
 * return empty so routes can 404.
 */
type UserScopedCase = {
  readonly scope: "user";
  /** The ids of the caller's own records that this answer discloses. */
  readonly disclose: (world: World, userId: string) => Promise<readonly string[]>;
  /** The id only the owner may ever see in that list. */
  readonly secret: (world: World) => string;
};

/** A helper that takes no `userId` because it is only reachable behind one that does. */
type UnscopedCase = {
  readonly scope: "unscoped";
  readonly why: string;
  readonly exercise: (world: World) => Promise<void>;
};

const CASES: Readonly<Record<string, UserScopedCase | UnscopedCase>> = {
  listWorkspaces: {
    scope: "user",
    disclose: async (_world, userId) =>
      (await workspaceQueries.listWorkspaces(userId)).map((row) => row.id),
    secret: (world) => world.ownersCase.workspaceId,
  },
  getWorkspace: {
    scope: "user",
    disclose: async (world, userId) => {
      const detail = await workspaceQueries.getWorkspace(world.ownersCase.workspaceId, userId);
      return detail ? [detail.id] : [];
    },
    secret: (world) => world.ownersCase.workspaceId,
  },
  getWorkspaceForExport: {
    scope: "user",
    disclose: async (world, userId) => {
      const detail = await workspaceQueries.getWorkspaceForExport(
        world.ownersCase.workspaceId,
        userId,
      );
      return detail ? [detail.id] : [];
    },
    secret: (world) => world.ownersCase.workspaceId,
  },
  assertOwnsWorkspace: {
    scope: "user",
    disclose: async (world, userId) => {
      const id = await workspaceQueries.assertOwnsWorkspace(world.ownersCase.workspaceId, userId);
      return id ? [id] : [];
    },
    secret: (world) => world.ownersCase.workspaceId,
  },
  assertOwnsItem: {
    scope: "user",
    disclose: async (world, userId) => {
      const row = await workspaceQueries.assertOwnsItem(world.ownersCase.toolItemId, userId);
      return row ? [row.id] : [];
    },
    secret: (world) => world.ownersCase.toolItemId,
  },
  assertOwnsNote: {
    scope: "user",
    disclose: async (world, userId) => {
      const row = await workspaceQueries.assertOwnsNote(world.ownersCase.noteId, userId);
      return row ? [row.id] : [];
    },
    secret: (world) => world.ownersCase.noteId,
  },
  listWorkspacesForPlaybook: {
    scope: "user",
    disclose: async (world, userId) =>
      (
        await workspaceQueries.listWorkspacesForPlaybook(
          world.catalogue.publishedPlaybookId,
          userId,
        )
      ).map((row) => row.id),
    secret: (world) => world.ownersCase.workspaceId,
  },
  nextItemOrderIndex: {
    scope: "unscoped",
    why:
      "It returns `max(order_index) + 1` for a workspace and kind — an integer, no row content " +
      "— and is called only from inside `addWorkspaceItem`'s transaction, after " +
      "`assertOwnsWorkspace` has already bound the session user. Adding a `userId` here would " +
      "be a second predicate on rows the caller has already been proved to own.",
    exercise: async (world) => {
      const next = await workspaceQueries.nextItemOrderIndex(
        world.ownersCase.workspaceId,
        "checklistStep",
      );
      expect(next).toBe(world.ownersCase.checklistItemIds.length);
    },
  },
};

requireDatabaseOrFailInCI("lib/queries/workspaces.ts");

describeWithDatabase("lib/queries/workspaces.ts — every read is scoped to the session user", () => {
  let world: World;

  beforeAll(async () => {
    const catalogue = await createCatalogue();
    const owner = await createActor();
    const stranger = await createActor();
    world = {
      owner,
      stranger,
      catalogue,
      ownersCase: await createCaseFile(owner.id, catalogue, "Owner case"),
      strangersCase: await createCaseFile(stranger.id, catalogue, "Stranger case"),
    };
  });

  afterAll(async () => {
    await closeDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ---------------------------------------------------------------- *
   * The table cannot drift from the module
   * ---------------------------------------------------------------- */

  it("classifies every exported query, and no query that no longer exists", () => {
    expect(Object.keys(CASES).sort()).toEqual(exportedQueryNames);
  });

  it("finds the queries it is supposed to be checking", () => {
    // Fail loudly rather than silently checking nothing.
    expect(exportedQueryNames.length).toBeGreaterThanOrEqual(8);
  });

  it("treats every query that accepts a userId as user-scoped", () => {
    // A query taking a `userId` can't be classified as unscoped.
    const classifiedAsUserScoped = Object.entries(CASES)
      .filter(([, value]) => value.scope === "user")
      .map(([name]) => name)
      .sort();
    expect(classifiedAsUserScoped).toEqual(userScopedInSource);
  });

  it("wraps nothing in the shared cache", () => {
    // Session-dependent queries must never be cached. Checked with comments stripped.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*/g, "$1 ");
    expect(code).not.toMatch(/from\s+["']\.\/cache["']/);
    expect(code).not.toMatch(/unstable_cache/);
  });

  /* ---------------------------------------------------------------- *
   * The property, for every user-scoped query
   * ---------------------------------------------------------------- */

  for (const [name, testCase] of Object.entries(CASES)) {
    if (testCase.scope !== "user") {
      it(`${name}() takes no userId, and the reason is recorded`, async () => {
        expect(testCase.why.length).toBeGreaterThan(40);
        await testCase.exercise(world);
      });
      continue;
    }

    it(`${name}() discloses the case to its owner`, async () => {
      // Positive check: a query returning nothing would pass every leak assertion.
      expect(await testCase.disclose(world, world.owner.id)).toContain(testCase.secret(world));
    });

    it(`${name}() discloses nothing of it to a signed-in stranger`, async () => {
      // A real signed-in stranger; only the SQL predicate can stop this caller.
      expect(await testCase.disclose(world, world.stranger.id)).not.toContain(
        testCase.secret(world),
      );
    });

    it(`${name}() discloses nothing of it to an unknown user id`, async () => {
      expect(await testCase.disclose(world, unknownId())).not.toContain(testCase.secret(world));
    });
  }

  /* ---------------------------------------------------------------- *
   * What the empty answer must not leak
   * ---------------------------------------------------------------- */

  it("getWorkspace returns the whole case to its owner", async () => {
    const detail = await workspaceQueries.getWorkspace(
      world.ownersCase.workspaceId,
      world.owner.id,
    );
    expect(detail).not.toBeNull();
    expect(detail?.title).toBe(world.ownersCase.title);
    expect(detail?.checklist).toHaveLength(world.ownersCase.checklistItemIds.length);
    expect(detail?.savedTools.map((item) => item.title)).toEqual([world.catalogue.toolName]);
    expect(detail?.notes.map((note) => note.body)).toEqual([world.ownersCase.noteBody]);
    expect(detail?.savedFeatures.map((feature) => feature.featureRef)).toEqual([
      world.ownersCase.featureRef,
    ]);
    expect(detail?.playbook?.slug).toBeTruthy();
  });

  it("getWorkspace tells a stranger nothing about a case that exists", async () => {
    // Not-yours and nonexistent both return null, so both 404.
    const forStranger = await workspaceQueries.getWorkspace(
      world.ownersCase.workspaceId,
      world.stranger.id,
    );
    const forMissing = await workspaceQueries.getWorkspace(unknownId(), world.stranger.id);
    expect(forStranger).toBeNull();
    expect(forStranger).toEqual(forMissing);
  });

  it("listWorkspaces returns only the caller's own cases", async () => {
    const ownersList = await workspaceQueries.listWorkspaces(world.owner.id);
    const strangersList = await workspaceQueries.listWorkspaces(world.stranger.id);

    expect(ownersList.map((row) => row.id)).toContain(world.ownersCase.workspaceId);
    expect(ownersList.map((row) => row.id)).not.toContain(world.strangersCase.workspaceId);
    expect(strangersList.map((row) => row.id)).toContain(world.strangersCase.workspaceId);
    expect(strangersList.map((row) => row.id)).not.toContain(world.ownersCase.workspaceId);
  });

  it("listWorkspaces counts the case's own items and notes, not another case's", async () => {
    const row = (await workspaceQueries.listWorkspaces(world.owner.id)).find(
      (candidate) => candidate.id === world.ownersCase.workspaceId,
    );
    expect(row).toBeDefined();
    // 3 checklist + 1 tool + 1 map feature.
    expect(row?.itemCount).toBe(world.ownersCase.checklistItemIds.length + 2);
    expect(row?.noteCount).toBe(1);
    expect(row?.checkedCount).toBe(0);
  });

  it("listWorkspacesForPlaybook does not surface a stranger's case started from the same playbook", async () => {
    // Both users started from the same playbook; each sees only their own.
    const forOwner = await workspaceQueries.listWorkspacesForPlaybook(
      world.catalogue.publishedPlaybookId,
      world.owner.id,
    );
    expect(forOwner.map((row) => row.id)).toEqual([world.ownersCase.workspaceId]);
  });

  /* ---------------------------------------------------------------- *
   * The second predicate, which exists so a future refactor cannot leak
   * ---------------------------------------------------------------- */

  it("getWorkspace filters items and notes by user id as well as by workspace", async () => {
    /*
     * Items and notes queries also filter on the denormalised `user_id`. To prove it, create
     * rows in the owner's workspace stamped with another user id (no action can do this, but
     * a bad migration could).
     */
    const [plantedItem] = await db
      .insert(workspaceItems)
      .values({
        workspaceId: world.ownersCase.workspaceId,
        userId: world.stranger.id,
        kind: "tool",
        title: "Planted by a hypothetical denormalisation bug",
        orderIndex: 99,
      })
      .returning({ id: workspaceItems.id });
    const [plantedNote] = await db
      .insert(notes)
      .values({
        workspaceId: world.ownersCase.workspaceId,
        userId: world.stranger.id,
        body: "Planted by a hypothetical denormalisation bug",
      })
      .returning({ id: notes.id });
    expect(plantedItem).toBeDefined();
    expect(plantedNote).toBeDefined();

    try {
      const detail = await workspaceQueries.getWorkspace(
        world.ownersCase.workspaceId,
        world.owner.id,
      );
      expect(detail?.savedTools.map((item) => item.id)).not.toContain(plantedItem?.id);
      expect(detail?.notes.map((note) => note.id)).not.toContain(plantedNote?.id);
    } finally {
      if (plantedItem) {
        await db.delete(workspaceItems).where(eq(workspaceItems.id, plantedItem.id));
      }
      if (plantedNote) await db.delete(notes).where(eq(notes.id, plantedNote.id));
    }
  });

  it("assertOwnsItem resolves ownership from the item's own row, not from its workspace", async () => {
    // A single predicate, given an item id resolved elsewhere.
    const owned = await workspaceQueries.assertOwnsItem(
      world.ownersCase.checklistItemId,
      world.owner.id,
    );
    expect(owned?.workspaceId).toBe(world.ownersCase.workspaceId);
    expect(owned?.kind).toBe("checklistStep");

    const notOwned = await workspaceQueries.assertOwnsItem(
      world.strangersCase.checklistItemId,
      world.owner.id,
    );
    expect(notOwned).toBeNull();
  });

  it("the assertOwns* helpers apply the same predicate inside a transaction", async () => {
    // Actions pass a transaction; the predicate must still apply.
    await db.transaction(async (tx) => {
      expect(
        await workspaceQueries.assertOwnsWorkspace(
          world.ownersCase.workspaceId,
          world.stranger.id,
          tx,
        ),
      ).toBeNull();
      expect(
        await workspaceQueries.assertOwnsWorkspace(world.ownersCase.workspaceId, world.owner.id, tx),
      ).toBe(world.ownersCase.workspaceId);
      expect(
        await workspaceQueries.assertOwnsNote(world.ownersCase.noteId, world.stranger.id, tx),
      ).toBeNull();
      expect(
        await workspaceQueries.assertOwnsItem(world.ownersCase.toolItemId, world.stranger.id, tx),
      ).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- *
   * Partial states that are normal, not corruption
   * ---------------------------------------------------------------- */

  it("keeps a saved tool in the case after an editor unpublishes it, without a link", async () => {
    // The snapshot title survives; slug and freshness go once the tool is unpublished.
    await db
      .update(tools)
      .set({ status: "draft" })
      .where(eq(tools.id, world.catalogue.toolId));

    try {
      const detail = await workspaceQueries.getWorkspace(
        world.ownersCase.workspaceId,
        world.owner.id,
      );
      const saved = detail?.savedTools.find(
        (item) => item.id === world.ownersCase.toolItemId,
      );
      expect(saved?.title).toBe(world.catalogue.toolName);
      expect(saved?.toolSlug).toBeNull();
      expect(saved?.toolConfidence).toBeNull();
      expect(saved?.toolLastVerifiedAt).toBeNull();
    } finally {
      await db
        .update(tools)
        .set({ status: "published" })
        .where(eq(tools.id, world.catalogue.toolId));
    }
  });

  it("returns a case that was not started from a playbook, with no playbook attached", async () => {
    // A case begun from scratch has `playbook: null`.
    const [bare] = await db
      .insert(workspaces)
      .values({ userId: world.owner.id, title: "Started from scratch" })
      .returning({ id: workspaces.id });
    expect(bare).toBeDefined();

    const detail = await workspaceQueries.getWorkspace(bare?.id ?? "", world.owner.id);
    expect(detail?.playbook).toBeNull();
    expect(detail?.checklist).toEqual([]);
    expect(detail?.savedFeatures).toEqual([]);

    const summary = (await workspaceQueries.listWorkspaces(world.owner.id)).find(
      (row) => row.id === bare?.id,
    );
    expect(summary?.playbookSlug).toBeNull();
    expect(summary?.playbookTitle).toBeNull();
  });

  it("skips a mapFeature row that has no snapshot rather than rendering it half-built", async () => {
    // Shouldn't happen via actions, but the read must skip a mapFeature with no snapshot.
    const [orphan] = await db
      .insert(workspaceItems)
      .values({
        workspaceId: world.ownersCase.workspaceId,
        userId: world.owner.id,
        kind: "mapFeature",
        title: "A feature with no snapshot",
        orderIndex: 50,
      })
      .returning({ id: workspaceItems.id });
    expect(orphan).toBeDefined();

    try {
      const detail = await workspaceQueries.getWorkspace(
        world.ownersCase.workspaceId,
        world.owner.id,
      );
      expect(detail?.savedFeatures.map((feature) => feature.id)).not.toContain(orphan?.id);
      expect(detail?.savedFeatures.map((feature) => feature.featureRef)).toEqual([
        world.ownersCase.featureRef,
      ]);
    } finally {
      if (orphan) await db.delete(workspaceItems).where(eq(workspaceItems.id, orphan.id));
    }
  });

  /* ---------------------------------------------------------------- *
   * Query counts
   * ---------------------------------------------------------------- */

  it("listWorkspaces is one round trip regardless of how many cases the user has", async () => {
    // Correlated subqueries keep this to one statement.
    const extra = await createCaseFile(world.owner.id, world.catalogue, "Extra case");
    expect(extra.workspaceId).toBeTruthy();

    const spy = vi.spyOn(pool, "query");
    await workspaceQueries.listWorkspaces(world.owner.id);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("getWorkspace is three round trips regardless of how many items the case holds", async () => {
    // Workspace, items (with joins), notes. No per-tool reads.
    const spy = vi.spyOn(pool, "query");
    const detail = await workspaceQueries.getWorkspace(
      world.ownersCase.workspaceId,
      world.owner.id,
    );
    expect(detail?.savedTools.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("getWorkspace stops after the ownership check for a stranger", async () => {
    // For a non-owner, items and notes are never read.
    const spy = vi.spyOn(pool, "query");
    await workspaceQueries.getWorkspace(world.ownersCase.workspaceId, world.stranger.id);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  /* ---------------------------------------------------------------- *
   * The export read is the same read
   * ---------------------------------------------------------------- */

  it("getWorkspaceForExport is getWorkspace, so the two cannot disagree", async () => {
    const [detail, exported] = await Promise.all([
      workspaceQueries.getWorkspace(world.ownersCase.workspaceId, world.owner.id),
      workspaceQueries.getWorkspaceForExport(world.ownersCase.workspaceId, world.owner.id),
    ]);
    expect(exported).toEqual(detail);
  });

  it("getWorkspaceForExport re-checks ownership rather than trusting a resolved id", async () => {
    // Ownership is re-checked on every export call.
    expect(
      await workspaceQueries.getWorkspaceForExport(
        world.ownersCase.workspaceId,
        world.stranger.id,
      ),
    ).toBeNull();
  });

  /* ---------------------------------------------------------------- *
   * Status and ordering, so the reads are covered as reads too
   * ---------------------------------------------------------------- */

  it("listWorkspaces orders by most recently updated and reflects a status change", async () => {
    await db
      .update(workspaces)
      .set({ status: "archived", updatedAt: new Date() })
      .where(
        and(
          eq(workspaces.id, world.ownersCase.workspaceId),
          eq(workspaces.userId, world.owner.id),
        ),
      );

    const list = await workspaceQueries.listWorkspaces(world.owner.id);
    expect(list[0]?.id).toBe(world.ownersCase.workspaceId);
    expect(list[0]?.status).toBe("archived");

    await db
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, world.ownersCase.workspaceId));
  });
});
