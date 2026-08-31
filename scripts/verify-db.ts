/**
 * Reads back what the migrations actually created.
 *
 * Uses `pg` rather than psql so it exercises the same driver the application does, and so
 * it works against the PGlite harness (which does not speak psql's SSL negotiation).
 * Assertions come from docs/architecture/HANDOFF.md section 11.
 */
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const client = new Client({ connectionString: url, ssl: false });

async function rows<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
  const result = await client.query<T>(sql);
  return result.rows;
}

async function main(): Promise<void> {
  await client.connect();

  const tables = await rows<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by 1",
  );
  console.log(`tables (${tables.length}):`);
  console.log("  " + tables.map((t) => t.table_name).join(", "));

  const generated = await rows<{ col: string }>(
    "select table_name || '.' || column_name as col from information_schema.columns where is_generated = 'ALWAYS' order by 1",
  );
  console.log(`\ngenerated columns (${generated.length}): ${generated.map((g) => g.col).join(", ")}`);

  const trgm = await rows<{ indexname: string }>(
    "select indexname from pg_indexes where indexname like '%trgm%' order by 1",
  );
  console.log(`trigram indexes (${trgm.length}): ${trgm.map((i) => i.indexname).join(", ")}`);

  const deferrable = await rows<{ conname: string; condeferrable: boolean; condeferred: boolean }>(
    "select conname, condeferrable, condeferred from pg_constraint where condeferrable order by 1",
  );
  console.log(
    `deferrable constraints (${deferrable.length}): ` +
      deferrable.map((c) => `${c.conname}(deferred=${c.condeferred})`).join(", "),
  );

  const checks = await rows<{ conname: string }>(
    "select conname from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace order by 1",
  );
  console.log(`\ncheck constraints (${checks.length})`);
  for (const name of [
    "tools_published_requires_verification_check",
    "playbooks_published_requires_verification_check",
  ]) {
    console.log(`  ${checks.some((c) => c.conname === name) ? "present" : "MISSING"}: ${name}`);
  }

  const indexes = await rows<{ n: string }>(
    "select count(*)::text as n from pg_indexes where schemaname = 'public'",
  );
  console.log(`\nindexes: ${indexes[0]?.n ?? "?"}`);

  await client.end();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await client.end().catch(() => {});
  process.exit(1);
});
