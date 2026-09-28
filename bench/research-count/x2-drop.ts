/** Drop X2 research schemas (research_count_x2, research_count_x2h) and record it. */
import { writeFileSync } from 'node:fs';
import { OUT, openPool, json } from './x2-lib.js';
const pool = await openPool(1);
try {
  for (const s of ['research_count_x2', 'research_count_x2h']) await pool.query(`drop schema if exists ${s} cascade`);
  const left = (await pool.query(`select nspname from pg_namespace where nspname like 'research_count_x2%'`)).rows;
  writeFileSync(`${OUT}/x2-drop.json`, json({ droppedAt: new Date().toISOString(), dropped: ['research_count_x2', 'research_count_x2h'], remaining: left }));
  console.log('dropped; remaining', left);
} finally { await pool.end(); }
