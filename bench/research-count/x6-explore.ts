/**
 * X6 explore (untimed EXPLAIN only, under lock): or2 on the ct1 copy table — seq scan vs BitmapOr (enable_seqscan off, session only)
 * vs a UNION ALL rewrite driven by each leaf's index; plus companion row compression facts.
 * Usage: rtk proxy npx tsx bench/research-count/x6-explore.ts
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { combos } from '../verify-native/r8-cases.js';
import { OUT, json, median } from './x2-lib.js';
import { makePlan } from './x4-lib.js';
import { SCHEMA6 as S, lock, unlock } from './x6-lib.js';

const pool = new pg.Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1, options: '-c default_transaction_read_only=on' });
await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
const res: any = { startedAt: new Date().toISOString() };
await lock('explore');
try {
  const or2 = combos.find(c => c.name === 'or2')!; const p = await makePlan(or2.node);
  const sel = `i."row_id", i."company_ct", i."memo_ct", ${p.flags.map(f => `${f.sql} as ${f.name}`).join(',')}`;
  const T = `"${S}"."customers_seal_index_ct" i`;
  const cl = await pool.connect(); try {
  const ex = async (label: string, text: string, pre: string[] = []) => {
    for (const s of pre) await cl.query(s); const t: number[] = []; let plan: any;
    for (let i = 0; i < 5; i++) { plan = (await cl.query(`explain (analyze, buffers, format json) ${text}`, p.params)).rows[0]['QUERY PLAN'][0]; if (i >= 2) t.push(plan['Execution Time']); }
    await cl.query('reset all');
    const nodes: string[] = []; const walk = (n: any) => { nodes.push(`${n['Node Type']}${n['Index Name'] ? `(${n['Index Name']})` : ''}`); (n.Plans ?? []).forEach(walk); }; walk(plan.Plan);
    const x = { label, serverExecMs: +median(t).toFixed(3), rows: plan.Plan['Actual Rows'], nodes: nodes.join(' > ') }; console.log(JSON.stringify(x)); return x;
  };
  res.or2 = [
    await ex('ct1 default', `select ${sel} from ${T} where i."scope_id"=$1 and ${p.where}`),
    await ex('ct1 enable_seqscan=off (BitmapOr)', `select ${sel} from ${T} where i."scope_id"=$1 and ${p.where}`, ['set enable_seqscan=off']),
  ];
  // leaves: p.where = ((A) or (B)); flags f0=A, f1=B. UNION ALL: A rows, then B-and-not-A rows (each driven by its own index).
  const [A, B] = p.flags.map(f => f.sql);
  res.or2.push(await ex('ct1 union all (A) + (B and not A)', `select ${sel} from ${T} where i."scope_id"=$1 and ${A} and $2::bigint is not null and $4::bigint[] is not null union all select ${sel} from ${T} where i."scope_id"=$1 and ${B} and not ${A} and $2::bigint is not null and $4::bigint[] is not null`));
  } catch (e) { console.error(e); throw e; } finally { cl.release(); }
  res.compression = (await pool.query(`select t, count(*) filter (where c is not null) compressed_cols, avg(w)::int avg_row_bytes from (
      select 'companion' t, pg_column_compression(tokens_792d75cf01821d67) c, pg_column_size(i.*) w from ${S}.customers_seal_index i
      union all select 'companion_ct', pg_column_compression(tokens_792d75cf01821d67), pg_column_size(i.*) from ${S}.customers_seal_index_ct i) s group by t`)).rows;
  console.log(JSON.stringify(res.compression));
  writeFileSync(`${OUT}/x6-explore.json`, json(res));
} finally { unlock(); await pool.end(); }
