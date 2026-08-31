import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
async function main() {
  const a = await pool.query("select outcome, duration_ms, upstream_status, actor_key, expires_at - requested_at as retention from connector_requests order by requested_at desc limit 5");
  console.log("audit rows:");
  for (const r of a.rows) console.log("  ", JSON.stringify(r));
  const rl = await pool.query("select key, count from rate_limits order by key");
  console.log("rate_limits:");
  for (const r of rl.rows) console.log("  ", JSON.stringify(r));
  await pool.end();
}
void main();
