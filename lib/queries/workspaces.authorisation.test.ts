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
 * `lib/queries/workspaces.ts`, against a real PostgreSQL. QA finding QV-16.
 *
 * WHAT THIS FILE IS FOR, stated plainly: **a read that takes a `userId` and does not filter
 * on it is an IDOR with a plausible signature.** It typechecks, it lints, it returns rows,
 * the page renders, and the only thing wrong with it is whose case file it returned. Nothing
 * above this layer would notice — the actions trust these functions, the pages trust the
 * actions, and the e2e suite only walks routes somebody thought to click.
 *
 * So every assertion here is made twice: once as the owner, and once as a *second real
 * signed-in user* who owns a case file of their own. A query that ignored its `userId`
 * would pass the first and fail the second. A stubbed database could not tell them apart at
 * all, which is why `tests/db/provision.ts` exists.
 *
 * THE TABLE IS DERIVED FROM THE MODULE'S EXPORTS, and separately from the source's parameter
 * lists. A new exported query is a test failure until somebody classifies it, and a new
 * query taking a `userId` is a test failure until it is proved to filter on it. Remembering
 * to add a row is not a control.
 */

const SOURCE = readFileSync(join(process.cwd(), "lib", "queries", "workspaces.ts"), "utf8");

/** Exported function names, read off the module object at run time. */
const exportedQueryNames = Object.entries(workspaceQueries)
  .filter(([, value]) => typeof value === "function")
  .map(([name]) => name)
  .sort();

/**
 * Exported functions whose signature accepts a `userId`. Read from the source rather than
 * from the module, because a function's parameter names do not survive to run time in a form
 * that can be trusted after bundling.
 */
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
 * One classified query, expressed as **what it discloses about the owner's case file**.
 *
 * Not "is the answer empty": a stranger has case files of their own, so `listWorkspaces`
 * answers them with rows, and an emptiness test would either be wrong or would have to be
 * weakened until it asserted nothing. The property is narrower and is the one that matters —
 * the ids the answer contains must never include `secret`, which is the owner's.
 *
 * There is deliberately no "throws" outcome: these functions return the empty answer so the
 * route above can render 404 rather than 403, because a 403 confirms the workspace exists
 * (HANDOFF §11 assertion 2).
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
    // A rename, a move, or an accidental `export {}` must fail loudly rather than silently
    // checking nothing.
    expect(exportedQueryNames.length).toBeGreaterThanOrEqual(8);
  });

  it("treats every query that accepts a userId as user-scoped", () => {
    // The one mechanical link between "this function claims to be scoped to a user" and
    // "this suite proves it filters on that user". A new query taking a `userId` fails here
    // until it is classified, and it cannot be classified `unscoped` while its signature
    // says otherwise.
    const classifiedAsUserScoped = Object.entries(CASES)
      .filter(([, value]) => value.scope === "user")
      .map(([name]) => name)
      .sort();
    expect(classifiedAsUserScoped).toEqual(userScopedInSource);
  });

  it("wraps nothing in the shared cache", () => {
    // caching.md §6: a query whose result depends on the session must never be cached. The
    // absence of the import is the enforcement, so it is asserted rather than assumed.
    //
    // Asserted against the source with comments stripped: the file's own header explains the
    // rule by naming `unstable_cache`, and a sentence saying why something is not done must
    // not be able to fail the test proving it is not done. (The same trap `code()` in
    // lib/actions/authorisation.test.ts exists for.)
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
      // The positive half matters as much as the negative one: a query that returned nothing
      // to everybody would pass every "must not leak" assertion in this file.
      expect(await testCase.disclose(world, world.owner.id)).toContain(testCase.secret(world));
    });

    it(`${name}() discloses nothing of it to a signed-in stranger`, async () => {
      // The stranger is a real, signed-in user with a case file of their own — not an absent
      // session. This is the caller a session check cannot stop and only a SQL predicate can.
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
    // Same call, same real id, different session. `null` and "no such workspace" are the
    // same value, which is what lets the route answer 404 for both.
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
    // Both users started a case from the same published playbook. The "resume" affordance
    // must show each of them only their own.
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
     * `workspace_items.user_id` and `notes.user_id` are denormalised from the workspace
     * (ADR 0008), and the file's own comment says queries 2 and 3 carry `user_id = $2`
     * "even though the workspace has already been proven to belong to the caller ... so a
     * future refactor that drops the first check cannot turn these into an information
     * leak". That claim is only worth having if it is true, and the only way to see it is to
     * create the state it defends against: rows inside the owner's workspace stamped with
     * somebody else's user id. No action can produce this today; a bad migration or a
     * transfer feature could.
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
    // The naive implementation reads the item, then reads its workspace, then compares
    // owners in TypeScript. This one is a single predicate, and it must answer for an item
    // id the caller resolved somewhere else — which is exactly how a caller arrives here.
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
    // The actions call these with the open transaction so the check and the write are one
    // atomic unit. The predicate must not become optional in that overload.
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
   * The partial states ADR 0008 says are normal, not corruption
   * ---------------------------------------------------------------- */

  it("keeps a saved tool in the case after an editor unpublishes it, without a link", async () => {
    // ADR 0008: the user's case is theirs and must not change because our catalogue did. The
    // snapshot title survives; the slug and the freshness chip go, because linking to a page
    // that 404s or asserting a confidence we no longer publish would both be worse.
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
    // `workspaces.playbook_id` is nullable and `playbook` is `null` rather than absent. A
    // case begun from scratch is an ordinary state, not a degraded one.
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
    /*
     * `addWorkspaceItem` writes the item and its snapshot in one transaction and rolls back
     * if the second does not land, so this state should not exist. It is created directly
     * here because "should not exist" is exactly the assumption a read must not depend on: a
     * saved feature with no coordinates and no credit is not something this product may
     * display, and the alternative to skipping it is an export that shows an observation with
     * a blank licence line.
     */
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
   * N+1, measured rather than asserted in a comment
   * ---------------------------------------------------------------- */

  it("listWorkspaces is one round trip regardless of how many cases the user has", async () => {
    // The counts are correlated subqueries precisely so this stays at one. A regression to
    // three joins would still be one query; a regression to a count per row would not.
    const extra = await createCaseFile(world.owner.id, world.catalogue, "Extra case");
    expect(extra.workspaceId).toBeTruthy();

    const spy = vi.spyOn(pool, "query");
    await workspaceQueries.listWorkspaces(world.owner.id);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("getWorkspace is three round trips regardless of how many items the case holds", async () => {
    // One for the workspace, one for the items (with the tool and step joins folded in), one
    // for the notes. QA finding Q-15 was a per-tool read behind this page; the join that
    // replaced it must not come back.
    const spy = vi.spyOn(pool, "query");
    const detail = await workspaceQueries.getWorkspace(
      world.ownersCase.workspaceId,
      world.owner.id,
    );
    expect(detail?.savedTools.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("getWorkspace stops after the ownership check for a stranger", async () => {
    // One statement, then nothing. A non-owner must not cause the items and notes of a case
    // to be read into this process at all.
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
    // The caller has already resolved this id — it is in the URL of a page they were shown.
    // A leaked export link is a leaked case file, so the predicate runs again on every call.
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
