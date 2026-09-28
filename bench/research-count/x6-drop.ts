/** Drop X6 research schema and record what remains. Usage: rtk proxy npx tsx bench/research-count/x6-drop.ts */
import { writeFileSync } from 'node:fs';
import { OUT, openPool, json } from './x2-lib.js';
const pool = await openPool(1);
try {
  await pool.query(`drop schema if exists research_count_x6 cascade`);
  const left = (await pool.query(`select nspname from pg_namespace where nspname like 'research_count_%'`)).rows.map(r => r.nspname);
  const r = { droppedAt: new Date().toISOString(), dropped: ['research_count_x6'], remainingResearchSchemas: left };
  writeFileSync(`${OUT}/x6-drop.json`, json(r)); console.log(json(r));
} finally { await pool.end(); }
