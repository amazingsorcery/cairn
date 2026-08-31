import { Client } from "pg";
async function attempt(sqlText: string, values: unknown[]) {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  c.on("error", (e) => console.log("   [client error event]", (e as {code?:string}).code));
  await c.connect();
  try {
    await c.query(sqlText, values);
    return "ACCEPTED";
  } catch (e) {
    const pg = e as { code?: string; constraint?: string; message?: string };
    return `REJECTED ${pg.code} ${pg.constraint ?? ""} ${pg.code ? "" : pg.message}`;
  } finally {
    try { await c.end(); } catch (e) { console.log("   [end error]", (e as Error).message); }
  }
}
async function main() {
  const cat = await (async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const r = await c.query("select id from categories limit 1");
    await c.end();
    return r.rows[0].id as string;
  })();
  console.log("1:", await attempt(
    `insert into tools (slug,name,url,summary,description,category_id,cost_model,status,last_verified_at,reliability)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    ["vp-a","N","https://e.invalid","summary text here","description text here", cat, "free", "published", null, null]));
  console.log("2:", await attempt(
    `insert into tools (slug,name,url,summary,description,category_id,cost_model,status,last_verified_at,reliability)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    ["vp-b","N","https://e.invalid","summary text here","description text here", cat, "free", "draft", null, null]));
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect(); await c.query("delete from tools where slug like 'vp-%'"); await c.end();
}
void main();
