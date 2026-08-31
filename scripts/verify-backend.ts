/**
 * Behavioural verification of the backend against a real database.
 *
 * `scripts/verify-db.ts` reads back what the migrations CREATED. This reads back what the
 * code DOES: the credibility CHECK actually firing, the `search_keywords` fan-out actually
 * recomputing, the rate-limit upsert actually serialising under concurrency, the ownership
 * predicate actually returning nothing to a non-owner, and the deferrable constraint
 * actually tolerating a swap while still rejecting a duplicate.
 *
 *   set -a; . ./.env.local; set +a
 *   DATABASE_POOL_MAX=1 ./node_modules/.bin/tsx scripts/verify-backend.ts
 *
 * Everything it writes it deletes. It is NOT safe against production — it inserts throwaway
 * users and tools — and refuses to run when NODE_ENV=production. Exits non-zero on failure,
 * so CI can gate on it once a `postgres:16` service is available.
 *
 * ── TWO STRUCTURAL CONCESSIONS TO THE LOCAL HARNESS ──────────────────────────
 * `scripts/dev-db.ts` is PGlite behind a TCP wire-protocol shim, and it diverges from real
 * PostgreSQL in two ways that shape this file:
 *
 *   1. **A connection is unusable after any statement error.** The error itself arrives
 *      intact — correct SQLSTATE, correct constraint name — and then the socket resets.
 *      Real PostgreSQL keeps the session. So every probe that EXPECTS a rejection runs on
 *      its own short-lived connection, in PHASE A, and issues exactly one failing statement.
 *   2. **It is single-connection.** So phase A finishes and closes before the pooled client
 *      in `lib/db.ts` is ever opened. Phase B then uses the application's own pool.
 *
 * Both concessions are harness-only. Against `postgres:16` the same assertions hold either
 * way; this structure simply also works locally.
 */
import { Client } from "pg";
import { and, eq, sql } from "drizzle-orm";

import {
  categories,
  notes,
  playbookSteps,
  playbooks,
  tags,
  toolTags,
  tools,
  users,
  workspaceItems,
  workspaces,
} from "@/db/schema";
import { recomputeToolSearchKeywords, toolIdsForTags } from "@/lib/actions/search-keywords";
import { closeDb, db } from "@/lib/db";
import { env } from "@/lib/env";
import { getToolBySlug } from "@/lib/queries/tools";
import { search, suggest } from "@/lib/queries/search";
import { assertOwnsWorkspace, getWorkspace } from "@/lib/queries/workspaces";
import { consume, deriveKey, sweepExpired } from "@/lib/rate-limit";

if (env.NODE_ENV === "production") {
  throw new Error("verify-backend.ts writes throwaway rows and must not run in production.");
}

let failures = 0;
let advisories = 0;

const pass = (name: string, detail = "") =>
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);

const fail = (name: string, detail: string) => {
  failures += 1;
  console.error(`  FAIL  ${name} — ${detail}`);
};

const advisory = (name: string, detail: string) => {
  advisories += 1;
  console.log(`  NOTE  ${name} — ${detail}`);
};

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) pass(name, detail);
  else fail(name, detail || "assertion failed");
}

async function section(title: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n${title}`);
  try {
    await body();
  } catch (error) {
    fail(title, error instanceof Error ? error.message : String(error));
  }
}

/* ================================================================== *
 * PHASE A — probes that expect a rejection, one throwaway connection each
 * ================================================================== */

type Rejection = { accepted: boolean; code: string; constraint: string };

/**
 * Open a connection, read what the probe needs, run ONE statement expected to fail, close.
 *
 * `setup` runs before the failing statement and on the same connection, because after the
 * failure the connection is gone (see the header note). Nothing here touches the
 * application's pool, so only one connection to the harness is ever open.
 */
async function probe<T>(
  setup: (client: Client) => Promise<T>,
  attempt: (client: Client, context: T) => Promise<unknown>,
  cleanup?: (client: Client, context: T) => Promise<unknown>,
): Promise<Rejection> {
  const client = new Client({ connectionString: env.DATABASE_URL });
  // The socket reset that follows the error would otherwise surface as an unhandled
  // 'error' event and take the process down.
  client.on("error", () => undefined);
  await client.connect();

  let result: Rejection;
  try {
    const context = await setup(client);
    await attempt(client, context);
    result = { accepted: true, code: "", constraint: "" };
    if (cleanup) await cleanup(client, context).catch(() => undefined);
  } catch (error) {
    const pg = error as { code?: string; constraint?: string };
    result = { accepted: false, code: pg.code ?? "", constraint: pg.constraint ?? "" };
  } finally {
    await client.end().catch(() => undefined);
  }
  return result;
}

const INSERT_TOOL = `
  insert into tools (slug, name, url, summary, description, category_id, cost_model,
                     status, last_verified_at, reliability)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

const TOOL_DEFAULTS = [
  "Verification probe",
  "https://example.invalid",
  "A throwaway row used to prove the publish gate fires.",
  "Inserted and removed by scripts/verify-backend.ts.",
] as const;

async function firstCategoryId(client: Client): Promise<string> {
  const r = await client.query<{ id: string }>("select id from categories limit 1");
  const id = r.rows[0]?.id;
  if (!id) throw new Error("no categories — run `pnpm db:seed` first");
  return id;
}

function toolProbe(
  slug: string,
  status: "draft" | "published",
  lastVerifiedAt: Date | null,
  reliability: number | null,
): Promise<Rejection> {
  return probe(
    firstCategoryId,
    (client, categoryId) =>
      client.query(INSERT_TOOL, [
        slug,
        ...TOOL_DEFAULTS,
        categoryId,
        "free",
        status,
        lastVerifiedAt,
        reliability,
      ]),
    (client) => client.query("delete from tools where slug = $1", [slug]),
  );
}

async function phaseA(): Promise<void> {
  await section("1. The credibility gate (ADR 0007, HANDOFF §11.4)", async () => {
    // (a) published with neither a verification date nor a reliability rating
    const a = await toolProbe("verify-probe-none", "published", null, null);
    check(
      "published tool with no lastVerifiedAt and no reliability is REJECTED",
      !a.accepted && a.constraint === "tools_published_requires_verification_check",
      a.accepted ? "ACCEPTED — the credibility gate is not enforced" : `${a.code} ${a.constraint}`,
    );

    // (b) published with a date but no rating — the gate needs BOTH
    const b = await toolProbe("verify-probe-half", "published", new Date(), null);
    check(
      "published tool with a date but no reliability is REJECTED",
      !b.accepted && b.constraint === "tools_published_requires_verification_check",
      b.accepted ? "ACCEPTED" : `${b.code} ${b.constraint}`,
    );

    // (c) published with both — the gate must not be a blanket refusal
    const c = await toolProbe("verify-probe-complete", "published", new Date(), 3);
    check("published tool with both is accepted", c.accepted, c.constraint);

    // (d) a draft may be half-finished (ADR 0007 §2)
    const d = await toolProbe("verify-probe-draft", "draft", null, null);
    check(
      "draft tool with neither is accepted (drafts may be half-finished)",
      d.accepted,
      d.constraint,
    );

    // (e) the same gate on playbooks
    const e = await probe(
      firstCategoryId,
      (client, categoryId) =>
        client.query(
          `insert into playbooks (slug, title, summary, category_id, difficulty,
                                  estimated_minutes, status)
           values ('verify-probe-playbook', 'Verification probe', 'A throwaway row.',
                   $1, 'beginner', 10, 'published')`,
          [categoryId],
        ),
      (client) => client.query("delete from playbooks where slug = 'verify-probe-playbook'"),
    );
    check(
      "published playbook with no lastVerifiedAt is REJECTED",
      !e.accepted && e.constraint === "playbooks_published_requires_verification_check",
      e.accepted ? "ACCEPTED" : `${e.code} ${e.constraint}`,
    );

    // (f) a reliability outside 1..5
    const f = await toolProbe("verify-probe-reliability", "draft", new Date(), 9);
    check(
      "reliability outside 1..5 is REJECTED",
      !f.accepted && f.constraint === "tools_reliability_range_check",
      f.accepted ? "ACCEPTED" : `${f.code} ${f.constraint}`,
    );
  });

  await section("2. The audit log cannot hold a raw identifier (ADR 0013 §2)", async () => {
    const g = await probe(
      async (client) => {
        const r = await client.query<{ id: string }>("select id from connectors limit 1");
        const id = r.rows[0]?.id;
        if (!id) throw new Error("no connectors — run `pnpm db:seed`");
        return id;
      },
      (client, connectorId) =>
        client.query(
          `insert into connector_requests (connector_id, outcome, duration_ms, actor_key, expires_at)
           values ($1, 'ok', 5, $2, now() + interval '30 days')`,
          [connectorId, "reporter@example.test"],
        ),
      (client) =>
        client.query("delete from connector_requests where actor_key !~ '^[0-9a-f]{64}$'"),
    );
    check(
      "a raw email address cannot be written to connector_requests.actor_key",
      !g.accepted && g.constraint === "connector_requests_actor_key_check",
      g.accepted ? "ACCEPTED — a raw identifier can be stored" : `${g.code} ${g.constraint}`,
    );
  });

  await section("3. Deferred, not disabled (HANDOFF §6, §11.8)", async () => {
    /**
     * One UPDATE that duplicates an existing `order_index`, with no compensating update.
     * If the constraint were simply absent this would be ACCEPTED. Section 7 in phase B
     * proves the other half: that a genuine swap inside one transaction succeeds.
     */
    const duplicate = await probe(
      async (client) => {
        const r = await client.query<{ id: string; order_index: number }>(
          `select s.id, s.order_index from playbook_steps s
           where s.playbook_id = (select playbook_id from playbook_steps limit 1)
           order by s.order_index limit 2`,
        );
        const [first, second] = r.rows;
        if (!first || !second) {
          throw new Error("need a playbook with two steps — run `pnpm db:seed`");
        }
        return { first, second };
      },
      (client, ctx) =>
        client.query("update playbook_steps set order_index = $1 where id = $2", [
          ctx.second.order_index,
          ctx.first.id,
        ]),
    );
    check(
      "a genuine duplicate order_index is rejected",
      !duplicate.accepted &&
        duplicate.code === "23505" &&
        duplicate.constraint === "playbook_steps_playbook_order_uniq",
      duplicate.accepted
        ? "ACCEPTED — the uniqueness constraint is missing entirely"
        : `${duplicate.code} ${duplicate.constraint}`,
    );
  });
}

/* ================================================================== *
 * PHASE B — everything else, through the application's own pool
 * ================================================================== */

async function phaseB(): Promise<void> {
  await section("4. search_keywords fan-out on tag rename (HANDOFF §11.6)", async () => {
    const [tag] = await db
      .select({ id: tags.id, slug: tags.slug, name: tags.name })
      .from(tags)
      .innerJoin(toolTags, eq(toolTags.tagId, tags.id))
      .groupBy(tags.id, tags.slug, tags.name)
      .having(sql`count(*) >= 2`)
      .limit(1);

    if (!tag) throw new Error("no tag carried by two or more tools — run `pnpm db:seed`");

    const affected = await toolIdsForTags(db, [tag.id]);

    /**
     * The rename and the recompute run inside ONE transaction that COMMITS, and the
     * assertions read the committed result. That is the property under test: after the
     * transaction that renamed the tag, every carrier's `search_keywords` already reflects
     * the new name, so search is never briefly wrong.
     */
    await db.transaction(async (tx) => {
      await tx
        .update(tags)
        .set({ name: `Zzverifyprobe ${tag.name}` })
        .where(eq(tags.id, tag.id));
      await recomputeToolSearchKeywords(tx, affected);
    });

    const [carriers] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tools)
      .where(sql`${tools.searchKeywords} like ${"%Zzverifyprobe%"}`);

    const hits = await db.execute<{ n: string }>(sql`
      select count(*) as n from ${tools}
      where status = 'published'
        and search_vector @@ websearch_to_tsquery('english', ${"Zzverifyprobe"})
    `);
    const findable = Number(hits.rows[0]?.n ?? 0);

    check(
      "every tool carrying the tag is recomputed by the renaming transaction",
      (carriers?.n ?? 0) === affected.length && affected.length > 0,
      `${carriers?.n}/${affected.length} tools updated`,
    );
    check(
      "the tools are findable by the NEW tag name through the generated search_vector",
      findable === (carriers?.n ?? -1) && findable > 0,
      `${findable} findable`,
    );

    await db.transaction(async (tx) => {
      await tx.update(tags).set({ name: tag.name }).where(eq(tags.id, tag.id));
      await recomputeToolSearchKeywords(tx, affected);
    });

    const [restored] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tools)
      .where(sql`${tools.searchKeywords} like ${"%Zzverifyprobe%"}`);
    check("renaming back removes the probe name from every carrier", (restored?.n ?? -1) === 0);
  });

  await section("5. Search behaviour and query plan (search.md §6, §8)", async () => {
    const results = await search({ q: "certificate transparency", page: 1 });
    check(
      "full-text search returns ranked hits",
      results.tools.length > 0,
      `${results.tools.length} tools, ${results.playbooks.length} playbooks`,
    );
    check(
      "ranks land in the (0,1) band that ts_rank_cd normalisation 32 produces",
      results.tools.every((t) => t.rank > 0 && t.rank < 1),
      results.tools[0] ? `top rank ${results.tools[0].rank.toFixed(4)}` : "",
    );
    check(
      "results are ordered by descending rank",
      results.tools.every((t, i, all) => i === 0 || (all[i - 1]?.rank ?? 1) >= t.rank),
    );

    // `websearch_to_tsquery` must never raise on punctuation. `to_tsquery` would 500 here.
    const junk = await search({ q: "foo & | ! ( ) : * ' \"", page: 1 });
    check("a malformed query does not raise", Array.isArray(junk.tools));

    const typo = await search({ q: "shodann", page: 1 });
    check(
      "the trigram fallback fires only when the ranked groups are empty (search.md §5)",
      typo.tools.length === 0 ? typo.didYouMean.length > 0 : typo.didYouMean.length === 0,
      typo.tools.length === 0
        ? `did-you-mean: ${typo.didYouMean.map((h) => h.slug).join(", ") || "none"}`
        : "exact hits found, fallback correctly not used",
    );

    const suggestions = await suggest("domain");
    check(
      "suggest returns at most 8 rows",
      suggestions.length > 0 && suggestions.length <= 8,
      `${suggestions.length} rows`,
    );

    /**
     * The plan. ADVISORY, because it is size-dependent: below a few hundred rows the planner
     * correctly prefers a sequential scan, and search.md §8 says so explicitly. What CAN be
     * asserted locally is that the GIN index exists and is usable — the part a
     * `drizzle-kit push` would silently destroy.
     */
    const plan = await db.execute<{ "QUERY PLAN": string }>(sql`
      explain
      with q as (select websearch_to_tsquery('english', 'certificate transparency') as query)
      select t.slug, ts_rank_cd(t.search_vector, q.query, 32) as rank
      from tools t, q
      where t.status = 'published' and t.search_vector @@ q.query
      order by rank desc, t.reliability desc nulls last, t.name asc
      limit 20
    `);
    const planText = plan.rows.map((r) => r["QUERY PLAN"]).join(" | ");

    const [published] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tools)
      .where(eq(tools.status, "published"));

    if (planText.includes("tools_search_vector_idx")) {
      pass("EXPLAIN uses tools_search_vector_idx");
    } else {
      advisory(
        "EXPLAIN prefers a sequential scan",
        `${published?.n ?? 0} published rows is below the size at which the planner picks ` +
          "the GIN index (search.md §8). This is NOT a pass. CI must assert " +
          "'Bitmap Index Scan on tools_search_vector_idx' against postgres:16.",
      );
    }

    // The `status` predicate is omitted here deliberately: on a small table the planner picks
    // the cheap btree on `status` even with `enable_seqscan` off, which proves nothing about
    // the GIN index. A bare `@@` query isolates it.
    await db.execute(sql`set enable_seqscan = off`);
    const forced = await db.execute<{ "QUERY PLAN": string }>(sql`
      explain select slug from ${tools}
      where search_vector @@ websearch_to_tsquery('english', 'certificate transparency')
    `);
    await db.execute(sql`set enable_seqscan = on`);
    const forcedText = forced.rows.map((r) => r["QUERY PLAN"]).join(" | ");
    check(
      "the GIN index exists and is usable for a @@ query",
      forcedText.includes("tools_search_vector_idx"),
      forcedText.includes("tools_search_vector_idx")
        ? "Bitmap Index Scan on tools_search_vector_idx"
        : forcedText,
    );
  });

  await section("6. Rate limiting (ADR 0009, HANDOFF §5, §11.12)", async () => {
    const subject = `verify-probe-${Date.now()}@example.invalid`;
    const policy = { limit: 3, windowSeconds: 60 };
    const now = new Date();

    const counts: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      counts.push((await consume("signin-email", subject, { policy, now })).count);
    }
    check(
      "the single-statement upsert increments monotonically",
      counts.join(",") === "1,2,3,4,5",
      `counts: ${counts.join(",")}`,
    );

    const over = await consume("signin-email", subject, { policy, now });
    check("requests past the limit are refused", !over.ok, `count ${over.count} > ${policy.limit}`);

    // Ten simultaneous calls must produce ten DISTINCT counts. A read-modify-write limiter
    // produces ten 1s here and lets ten requests through on a limit of one.
    const parallelSubject = `verify-parallel-${Date.now()}@example.invalid`;
    const parallel = await Promise.all(
      Array.from({ length: 10 }, () =>
        consume("search-suggest", parallelSubject, {
          policy: { limit: 100, windowSeconds: 60 },
          now,
        }),
      ),
    );
    const distinct = new Set(parallel.map((r) => r.count)).size;
    check(
      "concurrent calls serialise on the primary key (no lost updates)",
      distinct === 10,
      `${distinct}/10 distinct counts`,
    );

    // Two windows must be two rows, not one shared counter.
    const later = new Date(now.getTime() + 61_000);
    const nextWindow = await consume("signin-email", subject, { policy, now: later });
    check("a new window starts a new counter", nextWindow.count === 1, `count ${nextWindow.count}`);

    // HANDOFF §11.12, asserted against what is actually stored.
    const stored = await db.execute<{ key: string }>(sql`select key from rate_limits`);
    check(
      "no stored rate_limits.key contains an @ or a dotted quad",
      stored.rows.every((r) => !r.key.includes("@") && !/\d{1,3}(\.\d{1,3}){3}/.test(r.key)),
      `${stored.rows.length} keys inspected`,
    );
    check(
      "every stored key is <action>:<64 hex>",
      stored.rows.every((r) => /^[a-z-]+:[0-9a-f]{64}$/.test(r.key)),
      stored.rows[0] ? `e.g. ${stored.rows[0].key.slice(0, 30)}…` : "",
    );
    check(
      "the key derived in Node is byte-for-byte what Postgres holds",
      stored.rows.some((r) => r.key === deriveKey("signin-email", subject)),
    );

    await db.execute(sql`
      insert into rate_limits (key, window_start, count, expires_at)
      values ('verify-expired:0000000000000000000000000000000000000000000000000000000000000000',
              now() - interval '2 hours', 1, now() - interval '1 hour')
      on conflict do nothing
    `);
    const swept = await sweepExpired();
    check(
      "the maintenance sweep deletes expired counters",
      swept.rateLimits > 0,
      JSON.stringify(swept),
    );

    await db.execute(sql`
      delete from rate_limits
      where key like 'signin-email:%' or key like 'search-suggest:%' or key like 'verify-%'
    `);
  });

  await section("7. Workspace ownership is a SQL predicate (HANDOFF §11.2, §11.7)", async () => {
    const stamp = Date.now();
    const [owner] = await db
      .insert(users)
      .values({ email: `verify-owner-${stamp}@example.invalid`, name: "Probe owner" })
      .returning({ id: users.id });
    const [other] = await db
      .insert(users)
      .values({ email: `verify-other-${stamp}@example.invalid`, name: "Probe other" })
      .returning({ id: users.id });
    if (!owner || !other) throw new Error("could not create probe users");

    try {
      const [playbook] = await db
        .select({ id: playbooks.id })
        .from(playbooks)
        .where(eq(playbooks.status, "published"))
        .limit(1);
      const [tool] = await db
        .select({ id: tools.id, name: tools.name })
        .from(tools)
        .where(eq(tools.status, "published"))
        .limit(1);
      const [category] = await db.select({ id: categories.id }).from(categories).limit(1);
      if (!playbook || !tool || !category) throw new Error("run `pnpm db:seed` first");

      const [workspace] = await db
        .insert(workspaces)
        .values({ userId: owner.id, playbookId: playbook.id, title: "Probe case" })
        .returning({ id: workspaces.id });
      if (!workspace) throw new Error("could not create probe workspace");

      const steps = await db
        .select({ id: playbookSteps.id, title: playbookSteps.title })
        .from(playbookSteps)
        .where(eq(playbookSteps.playbookId, playbook.id));

      await db.insert(workspaceItems).values([
        ...steps.map((step, i) => ({
          workspaceId: workspace.id,
          userId: owner.id,
          kind: "checklistStep" as const,
          stepId: step.id,
          title: step.title,
          orderIndex: i,
        })),
        {
          workspaceId: workspace.id,
          userId: owner.id,
          kind: "tool" as const,
          toolId: tool.id,
          title: tool.name,
          orderIndex: 0,
          checked: true,
        },
      ]);
      await db
        .insert(notes)
        .values({ workspaceId: workspace.id, userId: owner.id, body: "A probe note." });

      const asOwner = await getWorkspace(workspace.id, owner.id);
      check("the owner sees the workspace", asOwner !== null);
      check(
        "the owner sees the derived checklist, the saved tool and the note",
        (asOwner?.checklist.length ?? 0) === steps.length &&
          (asOwner?.savedTools.length ?? 0) === 1 &&
          (asOwner?.notes.length ?? 0) === 1,
        `${asOwner?.checklist.length} checklist, ${asOwner?.savedTools.length} tools, ${asOwner?.notes.length} notes`,
      );
      check(
        "the checklist is ordered 0..n-1",
        (asOwner?.checklist ?? []).every((item, i) => item.orderIndex === i),
      );

      check(
        "a NON-OWNER gets null, which the route turns into 404 rather than 403",
        (await getWorkspace(workspace.id, other.id)) === null,
      );
      check(
        "assertOwnsWorkspace refuses a non-owner",
        (await assertOwnsWorkspace(workspace.id, other.id)) === null,
      );

      // ADR 0008 / HANDOFF §11.7 — an editorial delete must not remove a line from a case.
      const [probeTool] = await db
        .insert(tools)
        .values({
          slug: `verify-deletable-${stamp}`,
          name: "Probe deletable tool",
          url: "https://example.invalid",
          summary: "A throwaway tool used to prove ON DELETE SET NULL.",
          description: "Inserted and deleted by scripts/verify-backend.ts.",
          categoryId: category.id,
          costModel: "free",
          status: "draft",
        })
        .returning({ id: tools.id, name: tools.name });
      if (!probeTool) throw new Error("could not create probe tool");

      const [savedItem] = await db
        .insert(workspaceItems)
        .values({
          workspaceId: workspace.id,
          userId: owner.id,
          kind: "tool",
          toolId: probeTool.id,
          title: probeTool.name,
          orderIndex: 99,
          checked: true,
        })
        .returning({ id: workspaceItems.id });
      if (!savedItem) throw new Error("could not save probe tool");

      await db.delete(tools).where(eq(tools.id, probeTool.id));

      const [survivor] = await db
        .select({
          title: workspaceItems.title,
          toolId: workspaceItems.toolId,
          checked: workspaceItems.checked,
        })
        .from(workspaceItems)
        .where(eq(workspaceItems.id, savedItem.id));

      check(
        "deleting a tool leaves the workspace item with its title and checked state, toolId null",
        survivor?.title === probeTool.name &&
          survivor?.toolId === null &&
          survivor?.checked === true,
        JSON.stringify(survivor),
      );
    } finally {
      // Workspaces, items and notes cascade with the user.
      await db.delete(users).where(eq(users.id, owner.id));
      await db.delete(users).where(eq(users.id, other.id));
    }
  });

  await section("8. Reordering steps inside one transaction (HANDOFF §6, §11.8)", async () => {
    const [playbook] = await db.select({ id: playbooks.id }).from(playbooks).limit(1);
    if (!playbook) throw new Error("no playbooks — run `pnpm db:seed`");

    const read = () =>
      db
        .select({ id: playbookSteps.id, orderIndex: playbookSteps.orderIndex })
        .from(playbookSteps)
        .where(eq(playbookSteps.playbookId, playbook.id))
        .orderBy(playbookSteps.orderIndex);

    const before = await read();
    const [first, second] = before;
    if (!first || !second) throw new Error("playbook has fewer than two steps");

    /**
     * Two UPDATEs that transiently duplicate an `order_index`, inside ONE transaction.
     * Without `DEFERRABLE INITIALLY DEFERRED` the FIRST update aborts immediately — which is
     * precisely the drag-to-reorder failure HANDOFF §6 exists to prevent.
     */
    let swapped = true;
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(playbookSteps)
          .set({ orderIndex: second.orderIndex })
          .where(eq(playbookSteps.id, first.id));
        await tx
          .update(playbookSteps)
          .set({ orderIndex: first.orderIndex })
          .where(eq(playbookSteps.id, second.id));
      });
    } catch (error) {
      swapped = false;
      fail("swap inside one transaction", (error as Error).message);
    }
    check("two steps swap order_index inside one transaction", swapped);

    const afterSwap = await read();
    check("the swap took effect", afterSwap[0]?.id === second.id && afterSwap[1]?.id === first.id);

    await db.transaction(async (tx) => {
      await tx
        .update(playbookSteps)
        .set({ orderIndex: first.orderIndex })
        .where(eq(playbookSteps.id, first.id));
      await tx
        .update(playbookSteps)
        .set({ orderIndex: second.orderIndex })
        .where(eq(playbookSteps.id, second.id));
    });

    check(
      "the probe left the ordering as it found it",
      JSON.stringify(await read()) === JSON.stringify(before),
    );
  });

  await section("9. Public reads filter status='published' (HANDOFF §7, §11.3)", async () => {
    const [published] = await db
      .select({ slug: tools.slug })
      .from(tools)
      .where(eq(tools.status, "published"))
      .limit(1);
    if (!published) throw new Error("no published tools — run `pnpm db:seed`");

    check("a published tool is readable", (await getToolBySlug(published.slug)) !== null);
    check(
      "an unknown slug returns null, not an error",
      (await getToolBySlug("no-such-tool-anywhere")) === null,
    );

    // Flip to draft, read back through the SAME predicate the public query uses, flip back.
    await db.update(tools).set({ status: "draft" }).where(eq(tools.slug, published.slug));
    const visibleWhileDraft = await db
      .select({ slug: tools.slug })
      .from(tools)
      .where(and(eq(tools.slug, published.slug), eq(tools.status, "published")));
    await db.update(tools).set({ status: "published" }).where(eq(tools.slug, published.slug));

    check("the published predicate excludes a draft row", visibleWhileDraft.length === 0);

    const [restored] = await db
      .select({ status: tools.status })
      .from(tools)
      .where(eq(tools.slug, published.slug));
    check("the probe restored the row's status", restored?.status === "published");
  });

  await section("10. Seeded shape (content contract vs schema)", async () => {
    const rows = await db.execute<{ playbook: string; indexes: number[] }>(sql`
      select p.slug as playbook, array_agg(s.order_index order by s.order_index) as indexes
      from ${playbooks} p join ${playbookSteps} s on s.playbook_id = p.id
      group by p.slug order by p.slug
    `);

    check(
      "every playbook's order_index is 0-based and contiguous (content numbers from 1)",
      rows.rows.length > 0 && rows.rows.every((row) => row.indexes.every((v, i) => v === i)),
      rows.rows.map((r) => `${r.playbook}:${r.indexes.length}`).join(", "),
    );

    const [empty] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tools)
      .where(sql`${tools.searchKeywords} = ''`);
    check("no seeded tool has empty search_keywords", (empty?.n ?? -1) === 0);

    const [hyphenated] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tools)
      .where(sql`${tools.confidence} = 'needs-review'`);
    check(
      "no stored confidence is the hyphenated form (HANDOFF §11.10)",
      (hyphenated?.n ?? -1) === 0,
    );

    const embed = await db.execute<{ n: string }>(sql`
      select count(*) as n from cameras
      where status = 'published' and embed_permitted and connector_id is null
    `);
    check(
      "no published embedding camera lacks a connector (ADR 0012 §4)",
      Number(embed.rows[0]?.n ?? -1) === 0,
    );

    const basis = await db.execute<{ n: string }>(sql`
      select count(*) as n from connectors
      where status = 'published'
        and (terms_url is null or legal_basis is null or last_checked_at is null)
    `);
    check(
      "no published connector is missing its recorded legal basis (ADR 0012)",
      Number(basis.rows[0]?.n ?? -1) === 0,
    );

    const disabled = await db.execute<{ n: string }>(sql`
      select count(*) as n from connectors where enabled
    `);
    check(
      "every seeded connector is enabled = false (fail closed, ADR 0012 §1)",
      Number(disabled.rows[0]?.n ?? -1) === 0,
    );
  });
}

/* ================================================================== */

async function main(): Promise<void> {
  console.log("Verifying backend behaviour against", new URL(env.DATABASE_URL).host);
  await phaseA();
  await phaseB();

  console.log("");
  if (advisories > 0) console.log(`${advisories} advisory note(s) — see NOTE lines above.`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED.`);
    process.exitCode = 1;
    return;
  }
  console.log("All behavioural checks passed.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
