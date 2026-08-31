import { Pool } from "pg";
import { createHash } from "node:crypto";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
async function main() {
  const r = await pool.query(`
    select json_build_object(
      'tools', (select json_agg(json_build_object('id',id,'slug',slug,'status',status,'kw',search_keywords,'lv',last_verified_at,'pa',published_at) order by slug) from tools),
      'steps', (select json_agg(json_build_object('pb',p.slug,'oi',s.order_index,'t',s.title) order by p.slug, s.order_index) from playbook_steps s join playbooks p on p.id=s.playbook_id),
      'cams', (select json_agg(json_build_object('id',id,'slug',slug,'status',status,'vk',view_kind,'cid',connector_id) order by slug) from cameras),
      'conns', (select json_agg(json_build_object('id',id,'slug',slug,'status',status,'en',enabled) order by slug) from connectors),
      'tags', (select json_agg(json_build_object('id',id,'slug',slug,'name',name) order by slug) from tags),
      'links', (select count(*) from playbook_step_tools)
    ) as snap`);
  const snap = JSON.stringify(r.rows[0].snap);
  console.log("digest:", createHash("sha256").update(snap).digest("hex").slice(0, 32), "| bytes:", snap.length);
  await pool.end();
}
void main();
