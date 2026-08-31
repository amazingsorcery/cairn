/** Row counts for the seeded tables. Sanity check that a seed actually landed. */
import { Client } from "pg";

const TABLES = [
  "categories",
  "tools",
  "tags",
  "tool_tags",
  "playbooks",
  "playbook_steps",
  "playbook_step_tools",
  "cameras",
  "connectors",
  "users",
  "workspaces",
] as const;

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await client.connect();
  for (const table of TABLES) {
    const result = await client.query<{ n: string }>(`select count(*)::text as n from ${table}`);
    console.log(table.padEnd(22), result.rows[0]?.n ?? "?");
  }
  const published = await client.query<{ n: string }>(
    "select count(*)::text as n from tools where status = 'published'",
  );
  console.log("tools published".padEnd(22), published.rows[0]?.n ?? "?");
  await client.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
