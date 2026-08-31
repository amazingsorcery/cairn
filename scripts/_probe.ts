import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
async function main() {
  const q = async (sql: string) => (await pool.query(sql)).rows;
  console.log("counts:", JSON.stringify((await q(`
    select
      (select count(*) from categories) as categories,
      (select count(*) from tags) as tags,
      (select count(*) from tools) as tools,
      (select count(*) from tool_tags) as tool_tags,
      (select count(*) from playbooks) as playbooks,
      (select count(*) from playbook_steps) as steps,
      (select count(*) from playbook_step_tools) as step_tools,
      (select count(*) from connectors) as connectors,
      (select count(*) from cameras) as cameras
  `))[0]));
  console.log("published:", JSON.stringify((await q(`
    select
      (select count(*) from tools where status='published') as tools_pub,
      (select count(*) from playbooks where status='published') as playbooks_pub,
      (select count(*) from cameras where status='published') as cameras_pub,
      (select count(*) from tools where search_keywords = '') as empty_kw
  `))[0]));
  console.log("step order indexes (per playbook):");
  for (const r of await q(`select p.slug, array_agg(s.order_index order by s.order_index) as idx from playbooks p join playbook_steps s on s.playbook_id=p.id group by p.slug order by p.slug`)) {
    console.log("   ", (r as {slug:string}).slug, JSON.stringify((r as {idx:number[]}).idx));
  }
  console.log("sample search_keywords:");
  for (const r of await q(`select slug, left(search_keywords, 110) as kw from tools order by slug limit 3`)) {
    console.log("   ", JSON.stringify(r));
  }
  console.log("connectors:");
  for (const r of await q(`select slug, kind, status, enabled, attribution_required, terms_url is not null as has_terms, legal_basis is not null as has_basis, last_checked_at is not null as has_checked from connectors order by slug`)) {
    console.log("   ", JSON.stringify(r));
  }
  console.log("camera view kinds:", JSON.stringify(await q(`select view_kind, count(*) from cameras group by 1 order by 1`)));
  console.log("cameras embed+connector:", JSON.stringify((await q(`select count(*) filter (where embed_permitted) as embeddable, count(*) filter (where embed_permitted and connector_id is null) as embed_without_connector from cameras`))[0]));
  await pool.end();
}
void main();
