/** Drop X4 research schemas and record what remains. Usage: rtk proxy npx tsx bench/research-count/x4-drop.ts */
import { writeFileSync } from 'node:fs';
import { OUT, openPool, json } from './x2-lib.js';
const pool = await openPool(1);
try {
  for (const s of ['research_count_x4', 'research_count_x4w']) await pool.query(`drop schema if exists ${s} cascade`);
  const left = (await pool.query(`select nspname from pg_namespace where nspname like 'research_count_x4%'`)).rows.map(r => r.nspname);
  const r = { droppedAt: new Date().toISOString(), dropped: ['research_count_x4', 'research_count_x4w'], remainingX4: left };
  writeFileSync(`${OUT}/x4-drop.json`, json(r)); console.log(json(r));
} finally { await pool.end(); }
