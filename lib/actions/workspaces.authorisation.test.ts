import { readFileSync } from "node:fs";
import { join } from "node:path";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { workspaceFeatureSnapshots, workspaceItems, workspaces } from "@/db/schema";
import * as workspaceActions from "@/lib/actions/workspaces";
import type { ActionResult } from "@/lib/actions/result";
import { closeDb, db } from "@/lib/db";
import { clearPayloadCache, writePayload } from "@/lib/live/feature-cache";
import {
  requireDatabaseOrFailInCI,
  createActor,
  createCaseFile,
  createCatalogue,
  describeWithDatabase,
  dumpCases,
  unknownId,
  type Actor,
  type Catalogue,
  type CaseDump,
  type CaseFile,
} from "@/tests/db/harness";
import { sessionStore } from "@/tests/db/session";

/**
 * `lib/actions/workspaces.ts`, executed against a real PostgreSQL with a real session.
 * QA finding QV-16.
 *
 * `lib/actions/authorisation.test.ts` is the source-shape half of this property set: it reads
 * the code and asserts that every action calls a `require*` guard, guards before it parses,
 * and never compares ownership in TypeScript. That test catches the regression that looks
 * like a missing line. This file catches the one that does not — a guard that is present and
 * ineffective, a predicate that binds the wrong id, a refusal that still wrote a row. The two
 * are deliberately kept as one property set expressed twice, and neither replaces the other.
 *
 * ## The three assertions every action gets, and why each is separate
 *
 * 1. **Signed out** — a Server Action is a public HTTP endpoint with a generated name. Its
 *    authorisation is not inherited from the page that rendered the form.
 * 2. **Signed in as a stranger, submitting the owner's ids** — the caller a session check
 *    cannot stop. The answer must be `notFound`, never `forbidden`: a 403 confirms the
 *    workspace exists, which for an audience whose cases are the sensitive thing is an
 *    enumeration oracle (HANDOFF §11 assertion 2).
 * 3. **The owner** — because an action that refused everybody would pass 1 and 2.
 *
 * Every refusal is checked against a **dump of both users' entire case files** taken before
 * the call. "Returned an error" is not the property; "changed nothing" is.
 *
 * ## Identity is never taken from the payload
 *
 * Every stranger payload below carries a forged `userId` naming the owner. Zod strips it, and
 * the assertion is that it changes nothing — so these tests also stand as the proof that
 * ownership is derived from the session and the database rather than from a form field.
 *
 * ## The table is derived from the module's exports
 *
 * `expect(Object.keys(CASES).sort()).toEqual(exportedActionNames)` fails the moment an
 * eleventh action is exported. Adding a row is then not something anyone has to remember.
 */

vi.mock("next-auth", async () => {
  const { sessionStore: store } = await import("@/tests/db/session");
  /*
   * `lib/auth.ts` destructures `NextAuth(authConfig)` at module scope and imports nothing
   * else from this package at run time (the other two imports are types, which are erased).
   * Replacing the default export swaps the session store and leaves `currentUser`,
   * `requireUser` and the error classes — the code actually under test — untouched.
   *
   * The factory does NOT call `importOriginal()`. next-auth's own `lib/env.js` imports
   * `next/server` by a bare specifier that only Next's bundler resolves, so loading the real
   * module under Vitest fails with ERR_MODULE_NOT_FOUND before any test runs. Nothing is
   * lost: the surface `lib/auth.ts` uses is one function.
   */
  return { default: () => store.authModule() };
});

const exportedActionNames = Object.entries(workspaceActions)
  .filter(([, value]) => typeof value === "function")
  .map(([name]) => name)
  .sort();

type World = {
  owner: Actor;
  stranger: Actor;
  catalogue: Catalogue;
  ownersCase: CaseFile;
  strangersCase: CaseFile;
};

type Call = (world: World) => Promise<ActionResult<unknown>>;

/**
 * One action's row.
 *
 * `asStranger` is absent only for `createWorkspace`, which references nothing of anybody
 * else's — its ownership property is that the row it writes belongs to the *session* user,
 * and it is asserted separately below rather than skipped.
 */
type ActionCase = {
  /** A call the owner is entitled to make, with a valid payload. */
  readonly asOwner: Call;
  /** The same shape of call, naming the owner's records, made by a signed-in stranger. */
  readonly asStranger?: Call;
  /** What must be true afterwards when the owner's call succeeded. */
  readonly expectApplied: (world: World) => Promise<void>;
};

/** A forged identity field, attached to every stranger payload. Zod strips it. */
const FORGED = (world: World) => ({ userId: world.owner.id, ownerId: world.owner.id });

const CASES: Readonly<Record<string, ActionCase>> = {
  createWorkspace: {
    asOwner: (world) =>
      workspaceActions.createWorkspace({
        title: "A new case",
        playbookId: world.catalogue.publishedPlaybookId,
      }),
    expectApplied: async (world) => {
      const rows = await db
        .select({ id: workspaces.id, userId: workspaces.userId })
        .from(workspaces)
        .where(and(eq(workspaces.userId, world.owner.id), eq(workspaces.title, "A new case")));
      expect(rows).toHaveLength(1);
    },
  },

  updateWorkspace: {
    asOwner: (world) =>
      workspaceActions.updateWorkspace({
        id: world.ownersCase.workspaceId,
        title: "Renamed by its owner",
        status: "completed",
      }),
    asStranger: (world) =>
      workspaceActions.updateWorkspace({
        ...FORGED(world),
        id: world.ownersCase.workspaceId,
        title: "Renamed by a stranger",
        status: "archived",
      }),
    expectApplied: async (world) => {
      const row = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, world.ownersCase.workspaceId),
      });
      expect(row?.title).toBe("Renamed by its owner");
      expect(row?.status).toBe("completed");
    },
  },

  deleteWorkspace: {
    asOwner: (world) => workspaceActions.deleteWorkspace({ id: world.ownersCase.workspaceId }),
    asStranger: (world) =>
      workspaceActions.deleteWorkspace({ ...FORGED(world), id: world.ownersCase.workspaceId }),
    expectApplied: async (world) => {
      const row = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, world.ownersCase.workspaceId),
      });
      expect(row).toBeUndefined();
    },
  },

  addWorkspaceItem: {
    asOwner: (world) =>
      workspaceActions.addWorkspaceItem({
        workspaceId: world.ownersCase.workspaceId,
        kind: "tool",
        toolId: world.catalogue.secondToolId,
      }),
    asStranger: (world) =>
      workspaceActions.addWorkspaceItem({
        ...FORGED(world),
        workspaceId: world.ownersCase.workspaceId,
        kind: "tool",
        toolId: world.catalogue.secondToolId,
      }),
    expectApplied: async (world) => {
      const rows = await db
        .select({ title: workspaceItems.title })
        .from(workspaceItems)
        .where(
          and(
            eq(workspaceItems.workspaceId, world.ownersCase.workspaceId),
            eq(workspaceItems.toolId, world.catalogue.secondToolId),
          ),
        );
      // The title is read from `tools.name` in the database, never from the payload.
      expect(rows.map((row) => row.title)).toEqual([world.catalogue.secondToolName]);
    },
  },

  toggleWorkspaceItem: {
    asOwner: (world) =>
      workspaceActions.toggleWorkspaceItem({
        id: world.ownersCase.checklistItemId,
        checked: true,
      }),
    asStranger: (world) =>
      workspaceActions.toggleWorkspaceItem({
        ...FORGED(world),
        id: world.ownersCase.checklistItemId,
        checked: true,
      }),
    expectApplied: async (world) => {
      const row = await db.query.workspaceItems.findFirst({
        where: eq(workspaceItems.id, world.ownersCase.checklistItemId),
      });
      expect(row?.checked).toBe(true);
      expect(row?.checkedAt).toBeInstanceOf(Date);
    },
  },

  removeWorkspaceItem: {
    asOwner: (world) => workspaceActions.removeWorkspaceItem({ id: world.ownersCase.toolItemId }),
    asStranger: (world) =>
      workspaceActions.removeWorkspaceItem({ ...FORGED(world), id: world.ownersCase.toolItemId }),
    expectApplied: async (world) => {
      const row = await db.query.workspaceItems.findFirst({
        where: eq(workspaceItems.id, world.ownersCase.toolItemId),
      });
      expect(row).toBeUndefined();
    },
  },

  reorderWorkspaceItems: {
    asOwner: (world) =>
      workspaceActions.reorderWorkspaceItems({
        workspaceId: world.ownersCase.workspaceId,
        kind: "checklistStep",
        itemIds: [...world.ownersCase.checklistItemIds].reverse(),
      }),
    asStranger: (world) =>
      workspaceActions.reorderWorkspaceItems({
        ...FORGED(world),
        workspaceId: world.ownersCase.workspaceId,
        kind: "checklistStep",
        itemIds: [...world.ownersCase.checklistItemIds].reverse(),
      }),
    expectApplied: async (world) => {
      const rows = await db
        .select({ id: workspaceItems.id, orderIndex: workspaceItems.orderIndex })
        .from(workspaceItems)
        .where(
          and(
            eq(workspaceItems.workspaceId, world.ownersCase.workspaceId),
            eq(workspaceItems.kind, "checklistStep"),
          ),
        );
      const byIndex = [...rows].sort((a, b) => a.orderIndex - b.orderIndex).map((row) => row.id);
      expect(byIndex).toEqual([...world.ownersCase.checklistItemIds].reverse());
    },
  },

  createNote: {
    asOwner: (world) =>
      workspaceActions.createNote({
        workspaceId: world.ownersCase.workspaceId,
        body: "A note written by the case's owner.",
      }),
    asStranger: (world) =>
      workspaceActions.createNote({
        ...FORGED(world),
        workspaceId: world.ownersCase.workspaceId,
        body: "A note written into somebody else's case.",
      }),
    expectApplied: async (world) => {
      const dump = await dumpCases([world.owner.id]);
      expect(dump.notes.map((note) => note.body)).toContain("A note written by the case's owner.");
    },
  },

  updateNote: {
    asOwner: (world) =>
      workspaceActions.updateNote({ id: world.ownersCase.noteId, body: "Edited by its author." }),
    asStranger: (world) =>
      workspaceActions.updateNote({
        ...FORGED(world),
        id: world.ownersCase.noteId,
        body: "Edited by a stranger.",
      }),
    expectApplied: async (world) => {
      const dump = await dumpCases([world.owner.id]);
      const note = dump.notes.find((candidate) => candidate.id === world.ownersCase.noteId);
      expect(note?.body).toBe("Edited by its author.");
    },
  },

  deleteNote: {
    asOwner: (world) => workspaceActions.deleteNote({ id: world.ownersCase.noteId }),
    asStranger: (world) =>
      workspaceActions.deleteNote({ ...FORGED(world), id: world.ownersCase.noteId }),
    expectApplied: async (world) => {
      const dump = await dumpCases([world.owner.id]);
      expect(dump.notes.map((note) => note.id)).not.toContain(world.ownersCase.noteId);
    },
  },
};

requireDatabaseOrFailInCI("lib/actions/workspaces.ts");

describeWithDatabase("lib/actions/workspaces.ts — authorisation, against a real database", () => {
  let catalogue: Catalogue;
  let world: World;

  beforeAll(async () => {
    catalogue = await createCatalogue();
  });

  afterAll(async () => {
    await closeDb();
  });

  /**
   * A fresh owner, a fresh stranger and two fresh case files per test.
   *
   * Fresh *users* rather than fresh workspaces, because the rate limiter is keyed on the
   * user id: reusing one actor across thirty mutating tests would eventually have the
   * limiter, not the authorisation check, produce the refusal — and a test that passes for
   * the wrong reason is the failure mode this whole exercise exists to remove.
   */
  beforeEach(async () => {
    const owner = await createActor();
    const stranger = await createActor();
    world = {
      owner,
      stranger,
      catalogue,
      ownersCase: await createCaseFile(owner.id, catalogue, "Owner case"),
      strangersCase: await createCaseFile(stranger.id, catalogue, "Stranger case"),
    };
    sessionStore.signedOut();
    clearPayloadCache();
  });

  const dumpBoth = (): Promise<CaseDump> => dumpCases([world.owner.id, world.stranger.id]);

  /* ---------------------------------------------------------------- *
   * The table cannot drift from the module
   * ---------------------------------------------------------------- */

  it("covers every exported Server Action, and none that no longer exists", () => {
    expect(Object.keys(CASES).sort()).toEqual(exportedActionNames);
  });

  it("finds the ten actions it is supposed to be checking", () => {
    expect(exportedActionNames).toHaveLength(10);
  });

  it("has an ownership case for every action that names a record it did not create", () => {
    // `createWorkspace` is the only action with nothing of anyone else's to name. Every other
    // action takes an id from the request, and every one of those must be exercised as a
    // stranger. Stated as an assertion so a new action cannot quietly omit `asStranger`.
    const withoutStrangerCase = Object.entries(CASES)
      .filter(([, value]) => value.asStranger === undefined)
      .map(([name]) => name);
    expect(withoutStrangerCase).toEqual(["createWorkspace"]);
  });

  /* ---------------------------------------------------------------- *
   * The three assertions, for every action
   * ---------------------------------------------------------------- */

  for (const [name, testCase] of Object.entries(CASES)) {
    it(`${name}() refuses a signed-out caller and writes nothing`, async () => {
      const before = await dumpBoth();
      sessionStore.signedOut();

      const result = await testCase.asOwner(world);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("unauthenticated");
      expect(await dumpBoth()).toEqual(before);
    });

    it(`${name}() refuses a session that carries no user id`, async () => {
      // A half-built session row must read as signed out rather than as a user whose id is
      // `undefined` — which would reach SQL as a predicate matching nothing, or worse.
      const before = await dumpBoth();
      sessionStore.signedInWithoutUserId();

      const result = await testCase.asOwner(world);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("unauthenticated");
      expect(await dumpBoth()).toEqual(before);
    });

    if (testCase.asStranger) {
      const asStranger = testCase.asStranger;

      it(`${name}() answers a signed-in stranger with notFound, not forbidden`, async () => {
        const before = await dumpBoth();
        sessionStore.signedInAs(world.stranger);

        const result = await asStranger(world);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        // The distinction IS the security property: `forbidden` confirms the record exists.
        expect(result.code).not.toBe("forbidden");
        expect(result.code).toBe("notFound");
        expect(await dumpBoth()).toEqual(before);
      });

      it(`${name}() answers an admin who is not the owner with notFound too`, async () => {
        // There is no staff override on a case file. `role` gates the editorial surface; it
        // has never gated another person's notes, and an admin reading one would be the
        // product holding investigation material it has no lawful basis for
        // (product-brief §3.2 constraint 3).
        const before = await dumpBoth();
        const admin = await createActor("admin");
        sessionStore.signedInAs(admin);

        const result = await asStranger(world);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe("notFound");
        expect(await dumpBoth()).toEqual(before);
      });
    }

    it(`${name}() succeeds for the owner and applies the change`, async () => {
      sessionStore.signedInAs(world.owner);

      const result = await testCase.asOwner(world);

      expect(result.ok, `expected success, got ${JSON.stringify(result)}`).toBe(true);
      await testCase.expectApplied(world);
    });
  }

  /* ---------------------------------------------------------------- *
   * Create: identity comes from the session, not from the payload
   * ---------------------------------------------------------------- */

  it("createWorkspace writes the session user's id, never one from the payload", async () => {
    sessionStore.signedInAs(world.stranger);

    const result = await workspaceActions.createWorkspace({
      title: "Whose case is this",
      // Every plausible spelling of "make this belong to somebody else".
      userId: world.owner.id,
      user_id: world.owner.id,
      ownerId: world.owner.id,
      id: unknownId(),
    });

    expect(result.ok).toBe(true);
    // Scoped to this test's own two actors. Matching on the title alone would also match
    // rows left by previous runs — the harness deletes fixtures by age, not by truncation
    // (tests/db/provision.ts), precisely so a concurrent run cannot be wiped.
    const rows = await db
      .select({ userId: workspaces.userId })
      .from(workspaces)
      .where(
        and(
          inArray(workspaces.userId, [world.owner.id, world.stranger.id]),
          eq(workspaces.title, "Whose case is this"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(world.stranger.id);
  });

  it("createWorkspace stamps the session user on every derived checklist row", async () => {
    // The checklist is written inside the same transaction. A row stamped with the wrong
    // user id would be invisible to its own owner's reads and visible to somebody else's.
    sessionStore.signedInAs(world.owner);

    const result = await workspaceActions.createWorkspace({
      title: "Derived from a playbook",
      playbookId: world.catalogue.publishedPlaybookId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const created = result.data as { id: string };
    const items = await db
      .select({ userId: workspaceItems.userId, title: workspaceItems.title })
      .from(workspaceItems)
      .where(eq(workspaceItems.workspaceId, created.id));
    expect(items).toHaveLength(world.catalogue.publishedStepIds.length);
    expect(new Set(items.map((item) => item.userId))).toEqual(new Set([world.owner.id]));
    // Titles are snapshotted from `playbook_steps.title` in the same transaction (ADR 0008).
    expect(items.map((item) => item.title).sort()).toEqual(
      [...world.catalogue.publishedStepTitles].sort(),
    );
  });

  it("createWorkspace refuses to derive a checklist from an unpublished playbook", async () => {
    // A guessed uuid must not pull unpublished editorial work into a case file.
    sessionStore.signedInAs(world.owner);

    const result = await workspaceActions.createWorkspace({
      title: "From a draft",
      playbookId: world.catalogue.draftPlaybookId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const created = result.data as { id: string };
    const items = await db
      .select({ id: workspaceItems.id })
      .from(workspaceItems)
      .where(eq(workspaceItems.workspaceId, created.id));
    expect(items).toEqual([]);
  });

  /* ---------------------------------------------------------------- *
   * Cross-tenant shapes the per-action table does not reach
   * ---------------------------------------------------------------- */

  it("addWorkspaceItem cannot write into a stranger's workspace even from the owner's own session", async () => {
    sessionStore.signedInAs(world.owner);

    const result = await workspaceActions.addWorkspaceItem({
      workspaceId: world.strangersCase.workspaceId,
      kind: "tool",
      toolId: world.catalogue.secondToolId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("notFound");
    const items = await db
      .select({ id: workspaceItems.id })
      .from(workspaceItems)
      .where(
        and(
          eq(workspaceItems.workspaceId, world.strangersCase.workspaceId),
          eq(workspaceItems.toolId, world.catalogue.secondToolId),
        ),
      );
    expect(items).toEqual([]);
  });

  it("addWorkspaceItem refuses an unpublished tool", async () => {
    sessionStore.signedInAs(world.owner);

    const result = await workspaceActions.addWorkspaceItem({
      workspaceId: world.ownersCase.workspaceId,
      kind: "tool",
      toolId: world.catalogue.draftToolId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("notFound");
  });

  it("addWorkspaceItem snapshots a checklist title from the published step, not the payload", async () => {
    sessionStore.signedInAs(world.owner);
    const created = await workspaceActions.createWorkspace({ title: "Empty case" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const workspaceId = (created.data as { id: string }).id;
    const stepId = world.catalogue.publishedStepIds[0];
    expect(stepId).toBeDefined();

    const result = await workspaceActions.addWorkspaceItem({
      workspaceId,
      kind: "checklistStep",
      stepId,
      title: "A title the client would like to store",
    });

    expect(result.ok, `expected success, got ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;
    const item = await db.query.workspaceItems.findFirst({
      where: eq(workspaceItems.id, (result.data as { id: string }).id),
    });
    expect(item?.title).toBe(world.catalogue.publishedStepTitles[0]);
    expect(item?.userId).toBe(world.owner.id);
  });

  it("addWorkspaceItem refuses a step belonging to an unpublished playbook", async () => {
    sessionStore.signedInAs(world.owner);

    const result = await workspaceActions.addWorkspaceItem({
      workspaceId: world.ownersCase.workspaceId,
      kind: "checklistStep",
      stepId: world.catalogue.draftStepId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("notFound");
  });

  it("addWorkspaceItem reports a duplicate save as a conflict rather than writing twice", async () => {
    sessionStore.signedInAs(world.owner);

    const first = await workspaceActions.addWorkspaceItem({
      workspaceId: world.ownersCase.workspaceId,
      kind: "tool",
      toolId: world.catalogue.secondToolId,
    });
    const second = await workspaceActions.addWorkspaceItem({
      workspaceId: world.ownersCase.workspaceId,
      kind: "tool",
      toolId: world.catalogue.secondToolId,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("conflict");
    const rows = await db
      .select({ id: workspaceItems.id })
      .from(workspaceItems)
      .where(
        and(
          eq(workspaceItems.workspaceId, world.ownersCase.workspaceId),
          eq(workspaceItems.toolId, world.catalogue.secondToolId),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("createNote refuses an anchor to another user's item", async () => {
    // The workspace is the caller's; the anchor is not. Both are checked, in the same
    // transaction, with the same predicate.
    sessionStore.signedInAs(world.owner);

    const result = await workspaceActions.createNote({
      workspaceId: world.ownersCase.workspaceId,
      body: "Anchored to somebody else's item.",
      workspaceItemId: world.strangersCase.toolItemId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("notFound");
    const dump = await dumpCases([world.owner.id]);
    expect(dump.notes.map((note) => note.body)).not.toContain("Anchored to somebody else's item.");
  });

  it("reorderWorkspaceItems refuses a list that mixes in another user's item", async () => {
    // The workspace is the caller's and one submitted id is not. Applying the reorder
    // partially would leave the list half-rewritten, so the whole call is refused.
    sessionStore.signedInAs(world.owner);
    const before = await dumpBoth();

    const result = await workspaceActions.reorderWorkspaceItems({
      workspaceId: world.ownersCase.workspaceId,
      kind: "checklistStep",
      itemIds: [
        ...world.ownersCase.checklistItemIds.slice(0, 2),
        world.strangersCase.checklistItemId,
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("notFound");
    expect(await dumpBoth()).toEqual(before);
  });

  it("deleteWorkspace takes the case's items, notes and snapshots with it — and only that case", async () => {
    sessionStore.signedInAs(world.owner);

    const result = await workspaceActions.deleteWorkspace({ id: world.ownersCase.workspaceId });

    expect(result.ok).toBe(true);
    const after = await dumpCases([world.owner.id, world.stranger.id]);
    expect(after.items.filter((item) => item.workspaceId === world.ownersCase.workspaceId)).toEqual(
      [],
    );
    expect(after.notes.filter((note) => note.workspaceId === world.ownersCase.workspaceId)).toEqual(
      [],
    );
    expect(after.snapshots.map((row) => row.userId)).toEqual([world.stranger.id]);
    // The stranger's identically-shaped case is untouched.
    expect(after.workspaces.map((row) => row.id)).toContain(world.strangersCase.workspaceId);
  });

  it("the reorder statement carries its own owner predicate, which no call can reach", () => {
    /*
     * THE ONE ASSERTION IN THIS FILE THAT READS THE SOURCE, AND WHY.
     *
     * `reorderWorkspaceItems` refuses any list containing an id that is not the caller's
     * before it reaches the `UPDATE … FROM unnest(...)`, so the `i.user_id = $n and
     * i.workspace_id = $n` on that statement is unreachable defence in depth: deleting it
     * changes no observable behaviour, and every behavioural test in this file still passes.
     * That was confirmed by removing it and running the suite, not assumed.
     *
     * Unreachable is not unimportant. It is the predicate that keeps a bulk write scoped if
     * the scan above it is ever loosened — a "reorder is idempotent, skip the check" refactor
     * would otherwise convert an id list into an UPDATE across other people's rows. Since no
     * call can exercise it, it is asserted structurally, which is honest about what is being
     * checked rather than dressing a shape test up as a behavioural one.
     */
    const source = readFileSync(join(process.cwd(), "lib", "actions", "workspaces.ts"), "utf8");
    const statement = source.slice(source.indexOf("update ${workspaceItems} i"));
    expect(statement).toMatch(/i\.user_id = \$\{user\.id\}/);
    expect(statement).toMatch(/i\.workspace_id = \$\{workspaceId\}/);
  });

  /* ---------------------------------------------------------------- *
   * Saved map features — the snapshot is the server's record, not the client's
   * ---------------------------------------------------------------- */

  const cacheOneFeature = (featureRef: string): void => {
    // The same function `app/(public)/map/sources.ts` writes with after a governed poll.
    // Nothing here reaches an upstream: `findCachedFeature` reads this process's memory.
    writePayload(`fixture-live:${featureRef}`, {
      sourceSlug: "fixture-live",
      sourceName: "Fixture live source",
      sourceKind: "infrastructure",
      features: [
        {
          id: featureRef,
          kind: "infrastructure",
          latitude: 52.37,
          longitude: 4.9,
          label: "Fixture observation from the cache",
          properties: { operator: "Fixture operator" },
        },
      ],
      observedAt: new Date("2026-02-03T04:05:06.000Z"),
      cachedAt: new Date("2026-02-03T04:05:10.000Z"),
      ttlSeconds: 60,
      attribution: { text: "Fixture credit", licence: "Fixture licence" },
    });
  };

  it("addWorkspaceItem saves a live feature into the owner's case from the server's cache", async () => {
    const featureRef = "fixture-live-feature-1";
    cacheOneFeature(featureRef);
    sessionStore.signedInAs(world.owner);

    const result = await workspaceActions.addWorkspaceItem({
      workspaceId: world.ownersCase.workspaceId,
      kind: "mapFeature",
      feature: { sourceSlug: "fixture-live", featureRef },
      // Everything a crafted request would try to assert about the observation. None of it
      // has a field to land in: the payload schema accepts the reference and nothing else
      // (ADR 0025, QA finding QV-14).
      attribution: "Credit removed by the client",
      licence: "Public domain, allegedly",
      latitude: 0,
      longitude: 0,
      label: "Whatever the client says",
    });

    expect(result.ok, `expected success, got ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;
    const saved = result.data as { id: string };

    // The item's own title is the label the SERVER resolved, not the one the client sent.
    // ADR 0008: the snapshot records what the user saw, and what the user saw is what we
    // served them.
    const item = await db.query.workspaceItems.findFirst({
      where: eq(workspaceItems.id, saved.id),
    });
    expect(item?.title).toBe("Fixture observation from the cache");
    expect(item?.title).not.toBe("Whatever the client says");

    const snapshot = await db.query.workspaceFeatureSnapshots.findFirst({
      where: eq(workspaceFeatureSnapshots.workspaceItemId, saved.id),
    });
    expect(snapshot?.attribution).toBe("Fixture credit");
    expect(snapshot?.licence).toBe("Fixture licence");
    expect(snapshot?.latitude).toBeCloseTo(52.37, 5);
    expect(snapshot?.userId).toBe(world.owner.id);
    expect(snapshot?.observedAt?.toISOString()).toBe("2026-02-03T04:05:06.000Z");
  });

  it("addWorkspaceItem refuses to save a live feature into a stranger's case", async () => {
    const featureRef = "fixture-live-feature-2";
    cacheOneFeature(featureRef);
    sessionStore.signedInAs(world.stranger);
    const before = await dumpBoth();

    const result = await workspaceActions.addWorkspaceItem({
      workspaceId: world.ownersCase.workspaceId,
      kind: "mapFeature",
      feature: { sourceSlug: "fixture-live", featureRef },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Reached the ownership check with a resolvable feature, and was still refused there —
    // so the refusal is the ownership predicate, not the empty cache.
    expect(result.code).toBe("notFound");
    expect(await dumpBoth()).toEqual(before);
  });

  it("addWorkspaceItem rolls the item back when the same feature is already saved", async () => {
    /*
     * The second save must leave NO orphan. The item row is inserted before the snapshot, so
     * a naive implementation commits a `mapFeature` item with no coordinates, no source and
     * no credit — an entry that renders as nothing. `FeatureAlreadySaved` unwinds the whole
     * transaction instead, and the observable proof is the item count, not the error code.
     */
    const featureRef = "fixture-live-feature-3";
    cacheOneFeature(featureRef);
    sessionStore.signedInAs(world.owner);
    const payload = {
      workspaceId: world.ownersCase.workspaceId,
      kind: "mapFeature" as const,
      feature: { sourceSlug: "fixture-live", featureRef },
    };

    const first = await workspaceActions.addWorkspaceItem(payload);
    const second = await workspaceActions.addWorkspaceItem(payload);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("conflict");

    const dump = await dumpCases([world.owner.id]);
    const mapItems = dump.items.filter(
      (item) => item.workspaceId === world.ownersCase.workspaceId && item.kind === "mapFeature",
    );
    // The fixture's own saved feature, plus exactly one from this test. No orphan.
    expect(mapItems).toHaveLength(2);
    expect(dump.snapshots).toHaveLength(mapItems.length);
  });

  it("addWorkspaceItem refuses a feature the server never saw, rather than fetching it", async () => {
    // ADR 0025: a save must originate no outbound request. An uncached reference fails.
    sessionStore.signedInAs(world.owner);

    const result = await workspaceActions.addWorkspaceItem({
      workspaceId: world.ownersCase.workspaceId,
      kind: "mapFeature",
      feature: { sourceSlug: "fixture-live", featureRef: "never-polled" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("notFound");
  });

  /* ---------------------------------------------------------------- *
   * Validation is behind the guard, and refusals are not oracles
   * ---------------------------------------------------------------- */

  it("tells a signed-out caller nothing about whether their payload was well-formed", async () => {
    // Both a valid and a garbage payload must produce the same refusal. A validation error
    // that only a well-formed payload produces is an oracle for the id space.
    sessionStore.signedOut();

    const withValidPayload = await workspaceActions.updateWorkspace({
      id: world.ownersCase.workspaceId,
      title: "Well formed",
      status: "active",
    });
    const withGarbagePayload = await workspaceActions.updateWorkspace({ nonsense: true });

    expect(withValidPayload).toEqual(withGarbagePayload);
    expect(withValidPayload.ok).toBe(false);
  });

  it("gives the same answer for a stranger's workspace and for one that does not exist", async () => {
    sessionStore.signedInAs(world.stranger);

    const someoneElses = await workspaceActions.updateWorkspace({
      id: world.ownersCase.workspaceId,
      title: "Probe",
      status: "active",
    });
    const nonexistent = await workspaceActions.updateWorkspace({
      id: unknownId(),
      title: "Probe",
      status: "active",
    });

    expect(someoneElses).toEqual(nonexistent);
  });

  it("rejects a malformed payload from a signed-in owner with a field error", async () => {
    // The other side of the same coin: validation still happens, and still reports usefully,
    // once the caller has been established.
    sessionStore.signedInAs(world.owner);

    const result = await workspaceActions.updateWorkspace({
      id: world.ownersCase.workspaceId,
      title: "   ",
      status: "active",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation");
    expect(result.fieldErrors?.title).toBeDefined();
  });
});
