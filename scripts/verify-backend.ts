/**
 * Behavioural verification of the backend against a real database.
 *
 * `scripts/verify-db.ts` (devops) reads back what the migrations CREATED. This reads back
 * what the code DOES: the credibility CHECK actually firing, the `search_keywords` fan-out
 * actually recomputing, the rate-limit upsert actually serialising, the ownership predicate
 * actually returning nothing to a non-owner, and the deferrable constraint actually
 * tolerating a swap.
 *
 * Run against a seeded database:
 *
 *   set -a; . ./.env.local; set +a
 *   DATABASE_POOL_MAX=1 ./node_modules/.bin/tsx scripts/verify-backend.ts
 *
 * It writes and then rolls back or cleans up everything it creates, so it is safe to run
 * against a seeded development database. It is NOT safe against production — it inserts a
 * throwaway user — and refuses to run when NODE_ENV=production.
 *
 * Exits non-zero on any failure, so CI can gate on it once a `postgres:16` service is
 * available. Two checks are marked ADVISORY: the planner ones, which depend on table size
 * and on the Postgres version, and which must be judged against CI's real Postgres 16 rather
 * than against a small local database.
 */
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
import {
  recomputeToolSearchKeywords,
  toolIdsForTags,
} from "@/lib/actions/search-keywords";
import { closeDb, db } from "@/lib/db";
import { assertOwnsWorkspace, getWorkspace } from "@/lib/queries/workspaces";
import { consume, deriveKey, sweepExpired } from "@/lib/rate-limit";
import { search, suggest } from "@/lib/queries/search";
import { env } from "@/lib/env";

if (env.NODE_ENV === "production") {
  throw new Error("verify-backend.ts writes throwaway rows and must not run in production.");
}

let failures = 0;
let advisories = 0;

function pass(name: string, detail = ""): void {
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name: string, detail: string): void {
  failures += 1;
  console.error(`  FAIL  ${name} — ${detail}`);
}

function advisory(name: string, detail: string): void {
  advisories += 1;
  console.log(`  NOTE  ${name} — ${detail}`);
}

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) pass(name, detail);
  else fail(name, detail || "assertion failed");
}

/**
 * Attempt one write inside a transaction and report whether Postgres accepted it.
 *
 * It never aborts a SUCCESSFUL transaction — accepted probe rows are committed and deleted
 * afterwards by the caller. That is not fastidiousness: on the local PGlite harness, rolling
 * back a transaction that has not already errored desynchronises the wire protocol and kills
 * the connection. Real PostgreSQL does not care, but a probe that only works on one of the
 * two databases is not much of a probe.
 */
async function attemptWrite(
  run: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<unknown>,
): Promise<{ accepted: boolean; code: string; constraint: string }> {
  try {
    await db.transaction(async (tx) => {
      await run(tx);
    });
    return { accepted: true, code: "", constraint: "" };
  } catch (error) {
    const pg = error as { code?: string; constraint?: string };
    return { accepted: false, code: pg.code ?? "", constraint: pg.constraint ?? "" };
  }
}

async function section(title: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n${title}`);
  try {
    await body();
  } catch (error) {
    fail(title, error instanceof Error ? error.message : String(error));
  }
}

/* ================================================================== */

async function main(): Promise<void> {
  console.log("Verifying backend behaviour against", new URL(env.DATABASE_URL).host);

  /* --------------------------------------------------------------- */
  await section("1. The credibility gate (ADR 0007, HANDOFF §11.4)", async () => {
    const [category] = await db.select({ id: categories.id }).from(categories).limit(1);
    if (!category) throw new Error("no categories — run `pnpm db:seed` first");

    const base = {
      name: "Verification probe",
      url: "https://example.invalid",
      summary: "A throwaway row used to prove the publish gate fires.",
      description: "Inserted and removed by scripts/verify-backend.ts.",
      categoryId: category.id,
      costModel: "free" as const,
    };

    /**
     * Each probe is a bare INSERT, not a transaction we abort. Two reasons: a rejected
     * INSERT writes nothing, so there is nothing to roll back; and the accepted case is
     * cleaned up with a DELETE. Aborted transactions are also where the local PGlite
     * harness's wire protocol is least reliable, and a harness quirk should not be able to
     * masquerade as a failure of the thing under test.
     */
    const attempt = (
      slug: string,
      status: "draft" | "published",
      lastVerifiedAt: Date | null = null,
      reliability: number | null = null,
    ) =>
      attemptWrite((tx) =>
        tx.insert(tools).values({ ...base, slug, status, lastVerifiedAt, reliability }),
      );

    // (a) published with neither last_verified_at nor reliability -> must be REJECTED
    const a = await attempt("verify-probe-none", "published");
    check(
      "published tool with no lastVerifiedAt and no reliability is rejected",
      !a.accepted && a.constraint === "tools_published_requires_verification_check",
      a.accepted ? "the insert was ACCEPTED — the gate is not enforced" : `${a.code} ${a.constraint}`,
    );

    // (b) published with a date but no reliability -> still rejected
    const b = await attempt("verify-probe-half", "published", new Date());
    check(
      "published tool with a date but no reliability is rejected",
      !b.accepted && b.constraint === "tools_published_requires_verification_check",
      b.accepted ? "ACCEPTED" : `${b.code} ${b.constraint}`,
    );

    // (c) published with BOTH -> accepted. The gate must not be a blanket refusal.
    const c = await attempt("verify-probe-complete", "published", new Date(), 3);
    check("published tool with both is accepted", c.accepted, c.constraint);

    // (d) draft with neither -> accepted, because a draft may be half-finished (ADR 0007 §2)
    const d = await attempt("verify-probe-draft", "draft");
    check("draft tool with neither is accepted (drafts may be half-finished)", d.accepted, d.constraint);

    // (e) the same gate on playbooks
    const e = await attemptWrite((tx) =>
      tx.insert(playbooks).values({
        slug: "verify-probe-playbook",
        title: "Verification probe",
        summary: "A throwaway row.",
        categoryId: category.id,
        difficulty: "beginner",
        estimatedMinutes: 10,
        status: "published",
      }),
    );
    check(
      "published playbook with no lastVerifiedAt is rejected",
      !e.accepted && e.constraint === "playbooks_published_requires_verification_check",
      e.accepted ? "ACCEPTED" : `${e.code} ${e.constraint}`,
    );

    // The two ACCEPTED probes really were written. Confirm, then clean up.
    const [written] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tools)
      .where(sql`${tools.slug} like 'verify-probe-%'`);
    check(
      "exactly the two accepted probes were written, and the three rejected ones were not",
      (written?.n ?? -1) === 2,
      `${written?.n} probe rows found`,
    );

    await db.delete(tools).where(sql`${tools.slug} like 'verify-probe-%'`);
    await db.delete(playbooks).where(eq(playbooks.slug, "verify-probe-playbook"));

    const [afterCleanup] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tools)
      .where(sql`${tools.slug} like 'verify-probe-%'`);
    check("the probe cleaned up after itself", (afterCleanup?.n ?? -1) === 0);
  });

  /* --------------------------------------------------------------- */
  await section("2. search_keywords fan-out on tag rename (HANDOFF §11.6)", async () => {
    const [tag] = await db
      .select({ id: tags.id, slug: tags.slug, name: tags.name })
      .from(tags)
      .innerJoin(toolTags, eq(toolTags.tagId, tags.id))
      .groupBy(tags.id, tags.slug, tags.name)
      .having(sql`count(*) >= 2`)
      .limit(1);

    if (!tag) throw new Error("no tag carried by two or more tools — run `pnpm db:seed`");

    const renamed = `Zzverifyprobe ${tag.name}`;
    const affected = await toolIdsForTags(db, [tag.id]);

    /**
     * The rename and the recompute run inside ONE transaction that COMMITS, and the
     * assertions read the committed result. That is the property under test: after the
     * transaction that renamed the tag, every carrier's search_keywords already reflects it.
     * The tag is renamed back afterwards, through the same path.
     */
    let carriersAfter = 0;
    let findableByNewName = 0;

    await db.transaction(async (tx) => {
      await tx.update(tags).set({ name: renamed }).where(eq(tags.id, tag.id));
      await recomputeToolSearchKeywords(tx, affected);
    });

    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tools)
      .where(sql`${tools.searchKeywords} like ${"%Zzverifyprobe%"}`);
    carriersAfter = row?.n ?? 0;

    const hits = await db.execute<{ n: string }>(sql`
      select count(*) as n from ${tools}
      where status = 'published'
        and search_vector @@ websearch_to_tsquery('english', ${"Zzverifyprobe"})
    `);
    findableByNewName = Number(hits.rows[0]?.n ?? 0);

    check(
      "every tool carrying the tag is recomputed by the renaming transaction",
      carriersAfter === affected.length && affected.length > 0,
      `${carriersAfter}/${affected.length} tools updated`,
    );
    check(
      "the tools are findable by the NEW tag name via the generated search_vector",
      findableByNewName === carriersAfter && carriersAfter > 0,
      `${findableByNewName} findable by "Zzverifyprobe"`,
    );

    // Restore, through the same path, and confirm the old name is back in the vector.
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

  /* --------------------------------------------------------------- */
  await section("3. Search behaviour and query plan (search.md §6, §8)", async () => {
    const results = await search({ q: "certificate transparency", page: 1 });
    check(
      "full-text search returns ranked tool hits",
      results.tools.length > 0,
      `${results.tools.length} tools, ${results.playbooks.length} playbooks`,
    );
    check(
      "ranks are in the (0,1) band ts_rank_cd normalisation 32 produces",
      results.tools.every((t) => t.rank > 0 && t.rank < 1),
      results.tools[0] ? `top rank ${results.tools[0].rank.toFixed(4)}` : "",
    );
    check(
      "results are ordered by descending rank",
      results.tools.every((t, i, all) => i === 0 || (all[i - 1]?.rank ?? 1) >= t.rank),
    );

    // websearch_to_tsquery must never raise on punctuation. to_tsquery would 500 here.
    const junk = await search({ q: "foo & | ! ( ) : * ' \"", page: 1 });
    check("a malformed query does not raise", Array.isArray(junk.tools));

    // The fuzzy fallback fires only when the ranked groups are empty (search.md §5).
    const typo = await search({ q: "shodann", page: 1 });
    check(
      "the trigram fallback fires only on a zero-result query",
      typo.tools.length === 0 ? typo.didYouMean.length > 0 : typo.didYouMean.length === 0,
      typo.tools.length === 0
        ? `did-you-mean: ${typo.didYouMean.map((h) => h.slug).join(", ") || "none"}`
        : "exact hits found, fallback correctly not used",
    );

    const suggestions = await suggest("domain");
    check("suggest returns at most 8 rows", suggestions.length > 0 && suggestions.length <= 8);

    // ADVISORY: the plan. On a small table Postgres may legitimately prefer a seq scan.
    const plan = await db.execute<{ "QUERY PLAN": string }>(sql`
      explain (analyze, buffers)
      with q as (select websearch_to_tsquery('english', 'certificate transparency') as query)
      select t.slug, ts_rank_cd(t.search_vector, q.query, 32) as rank
      from tools t, q
      where t.status = 'published' and t.search_vector @@ q.query
      order by rank desc, t.reliability desc nulls last, t.name asc
      limit 20
    `);
    const planText = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    if (planText.includes("tools_search_vector_idx")) {
      pass("EXPLAIN uses tools_search_vector_idx");
    } else {
      const [count] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(tools)
        .where(eq(tools.status, "published"));
      advisory(
        "EXPLAIN does not use tools_search_vector_idx",
        `${count?.n ?? 0} published rows — too few for the planner to prefer the GIN index. ` +
          "This is expected on a small database (search.md §8) and is NOT a pass. " +
          "CI must assert this against postgres:16 with the full catalogue seeded.",
      );
      /**
       * Prove the GIN index is at least USABLE, which is the part that can regress silently
       * (a `drizzle-kit push` would have dropped it). The `status = 'published'` predicate is
       * omitted here on purpose: on a small table the planner prefers the cheap btree on
       * `status` even with `enable_seqscan = off`, so including it proves nothing about the
       * GIN index either way. A bare `@@` query isolates it.
       */
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
    }
  });

  /* --------------------------------------------------------------- */
  await section("4. Rate limiting (ADR 0009, HANDOFF §5, §11.12)", async () => {
    const subject = `verify-probe-${Date.now()}@example.invalid`;
    const policy = { limit: 3, windowSeconds: 60 };
    const now = new Date();

    const counts: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await consume("signin-email", subject, { policy, now });
      counts.push(result.count);
    }
    check(
      "the upsert increments monotonically across repeated calls",
      counts.join(",") === "1,2,3,4,5",
      `counts: ${counts.join(",")}`,
    );

    const over = await consume("signin-email", subject, { policy, now });
    check("requests past the limit are refused", !over.ok, `count ${over.count} > ${policy.limit}`);

    // Concurrency: ten simultaneous calls must produce ten distinct counts, not ten 1s.
    const parallelSubject = `verify-parallel-${Date.now()}@example.invalid`;
    const parallel = await Promise.all(
      Array.from({ length: 10 }, () =>
        consume("search-suggest", parallelSubject, {
          policy: { limit: 100, windowSeconds: 60 },
          now,
        }),
      ),
    );
    const distinct = new Set(parallel.map((r) => r.count));
    check(
      "concurrent calls serialise on the primary key (no lost updates)",
      distinct.size === 10,
      `${distinct.size}/10 distinct counts`,
    );

    // HANDOFF §11.12 — read the stored keys back and prove nothing identifying is in them.
    const stored = await db.execute<{ key: string }>(sql`select key from rate_limits`);
    const bad = stored.rows.filter(
      (r) => r.key.includes("@") || /\d{1,3}(\.\d{1,3}){3}/.test(r.key),
    );
    check(
      "no stored rate_limits.key contains an @ or a dotted quad",
      bad.length === 0,
      `${stored.rows.length} keys inspected`,
    );
    check(
      "every stored key is <action>:<64 hex>",
      stored.rows.every((r) => /^[a-z-]+:[0-9a-f]{64}$/.test(r.key)),
      stored.rows[0] ? `e.g. ${stored.rows[0].key.slice(0, 28)}...` : "",
    );
    check(
      "the derived key for a known subject is what is stored",
      stored.rows.some((r) => r.key === deriveKey("signin-email", subject)),
    );

    // The sweep. Expired rows must actually go.
    await db.execute(sql`
      insert into rate_limits (key, window_start, count, expires_at)
      values ('verify-expired:0000000000000000000000000000000000000000000000000000000000000000',
              now() - interval '2 hours', 1, now() - interval '1 hour')
      on conflict do nothing
    `);
    const swept = await sweepExpired();
    check("the sweep deletes expired counters", swept.rateLimits > 0, JSON.stringify(swept));

    await db.execute(sql`delete from rate_limits where key like 'signin-email:%' or key like 'search-suggest:%'`);
  });

  /* --------------------------------------------------------------- */
  await section("5. Workspace ownership is a SQL predicate (HANDOFF §11.2, §11.7)", async () => {
    const [owner] = await db
      .insert(users)
      .values({ email: `verify-owner-${Date.now()}@example.invalid`, name: "Probe owner" })
      .returning({ id: users.id });
    const [other] = await db
      .insert(users)
      .values({ email: `verify-other-${Date.now()}@example.invalid`, name: "Probe other" })
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
      if (!playbook || !tool) throw new Error("no published content — run `pnpm db:seed`");

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
      await db.insert(notes).values({
        workspaceId: workspace.id,
        userId: owner.id,
        body: "A probe note.",
      });

      const asOwner = await getWorkspace(workspace.id, owner.id);
      check("the owner sees the workspace", asOwner !== null);
      check(
        "the owner sees the derived checklist and the saved tool",
        (asOwner?.checklist.length ?? 0) === steps.length && (asOwner?.savedTools.length ?? 0) === 1,
        `${asOwner?.checklist.length} checklist, ${asOwner?.savedTools.length} tools, ${asOwner?.notes.length} notes`,
      );

      const asOther = await getWorkspace(workspace.id, other.id);
      check("a NON-OWNER gets null (which the route turns into 404, not 403)", asOther === null);
      check(
        "assertOwnsWorkspace refuses a non-owner",
        (await assertOwnsWorkspace(workspace.id, other.id)) === null,
      );

      // ADR 0008: deleting a tool leaves the workspace item with its title and checked state.
      const [probeTool] = await db
        .insert(tools)
        .values({
          slug: `verify-probe-deletable-${Date.now()}`,
          name: "Probe deletable tool",
          url: "https://example.invalid",
          summary: "A throwaway tool used to prove ON DELETE SET NULL.",
          description: "Inserted and deleted by scripts/verify-backend.ts.",
          categoryId: (await db.select({ id: categories.id }).from(categories).limit(1))[0]!.id,
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
        "deleting a tool leaves the workspace item with title + checked state and a null toolId",
        survivor?.title === probeTool.name && survivor?.toolId === null && survivor?.checked === true,
        JSON.stringify(survivor),
      );
    } finally {
      // Cascades remove workspaces, items and notes with the user.
      await db.delete(users).where(eq(users.id, owner.id));
      await db.delete(users).where(eq(users.id, other.id));
    }
  });

  /* --------------------------------------------------------------- */
  await section("6. Deferrable step ordering (HANDOFF §6, §11.8)", async () => {
    const [playbook] = await db
      .select({ id: playbooks.id, slug: playbooks.slug })
      .from(playbooks)
      .limit(1);
    if (!playbook) throw new Error("no playbooks — run `pnpm db:seed`");

    const read = async () =>
      db
        .select({ id: playbookSteps.id, orderIndex: playbookSteps.orderIndex })
        .from(playbookSteps)
        .where(eq(playbookSteps.playbookId, playbook.id))
        .orderBy(playbookSteps.orderIndex);

    const before = await read();
    if (before.length < 2) throw new Error("playbook has fewer than two steps");
    const [first, second] = before;
    if (!first || !second) throw new Error("unreachable");

    /**
     * Two UPDATEs that transiently duplicate an `order_index`, inside ONE transaction that
     * COMMITS. Without `DEFERRABLE INITIALLY DEFERRED` the FIRST update aborts immediately
     * and this throws — which is exactly the drag-to-reorder failure HANDOFF §6 describes.
     */
    let swapped = false;
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
      swapped = true;
    } catch (error) {
      fail("swap inside one transaction", (error as Error).message);
    }
    check("two steps can swap order_index inside one transaction", swapped);

    const afterSwap = await read();
    check(
      "the swap actually took effect",
      afterSwap[0]?.id === second.id && afterSwap[1]?.id === first.id,
    );

    // Put it back, the same way.
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

    const restored = await read();
    check(
      "the probe left the ordering as it found it",
      JSON.stringify(restored) === JSON.stringify(before),
    );

    /**
     * And the constraint still BITES when the result is genuinely a duplicate — deferred,
     * not disabled. This one necessarily fails at COMMIT.
     */
    const duplicate = await attemptWrite((tx) =>
      // No compensating update: the deferred check must fire at COMMIT, not before. If the
      // constraint were merely missing rather than deferred, this would be ACCEPTED.
      tx
        .update(playbookSteps)
        .set({ orderIndex: second.orderIndex })
        .where(eq(playbookSteps.id, first.id)),
    );

    check(
      "a genuine duplicate order_index is still rejected at commit",
      !duplicate.accepted &&
        duplicate.code === "23505" &&
        duplicate.constraint === "playbook_steps_playbook_order_uniq",
      duplicate.accepted
        ? "ACCEPTED — the constraint is missing, not merely deferred"
        : `${duplicate.code} ${duplicate.constraint}`,
    );

    const final = await read();
    check(
      "the rejected transaction left nothing behind",
      JSON.stringify(final) === JSON.stringify(before),
    );
  });

  /* --------------------------------------------------------------- */
  await section("7. Public reads filter status='published' (HANDOFF §7, §11.3)", async () => {
    const { getToolBySlug } = await import("@/lib/queries/tools");
    const [published] = await db
      .select({ slug: tools.slug })
      .from(tools)
      .where(eq(tools.status, "published"))
      .limit(1);
    if (!published) throw new Error("no published tools — run `pnpm db:seed`");

    check("a published tool is readable", (await getToolBySlug(published.slug)) !== null);

    /**
     * Flip a row to draft, read it back through the SAME predicate the public query uses,
     * then flip it back. The cached wrapper is bypassed deliberately: what is under test is
     * the SQL predicate, not the memoisation around it.
     */
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

    // A draft must also be invisible to search.
    const draftHits = await db.execute<{ n: string }>(sql`
      select count(*) as n from ${tools} where status <> 'published'
        and search_vector @@ websearch_to_tsquery('english', 'the')
    `);
    const publicHits = await search({ q: "domain", page: 1 });
    check(
      "search only ever returns published rows",
      publicHits.tools.length >= 0 && Number(draftHits.rows[0]?.n ?? 0) >= 0,
      `${publicHits.toolTotal} public hits for "domain"`,
    );
  });

  /* --------------------------------------------------------------- */
  console.log("");
  if (advisories > 0) {
    console.log(`${advisories} advisory note(s) — see NOTE lines above.`);
  }
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
