import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { compileSearch } from '../../src/core/search-predicate.js';
import { profiles, normalizeText } from '../../src/core/search-tokens.js';
import { candidateStatement } from '../../src/adapters/postgres/search-sql.js';
import { binding, fields, guard, pool, query, scopeId, source, sealer, setEvents, type Event } from './common.js';

type Mode = 'direct' | 256 | 1024 | 2048 | 4096;
const modes: Mode[] = ['direct', 256, 1024, 2048, 4096];
const targets = [10, 100, 500, 1000, 2000, 5000, 10000, 20000];
const select = Object.fromEntries(fields.map(field => [field, true]));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
const same = (actual: any[], expected: any[], label: string) => {
  assert.equal(actual.length, expected.length, `${label} row count`);
  for (let i = 0; i < actual.length; i++) {
    assert.equal(actual[i].id, expected[i].id, `${label} ID ${i}`);
    for (const field of fields) assert.equal(actual[i][field], expected[i][field], `${label} ${field} ${i}`);
  }
};
const counts = new Map<string, number>();
const outputDir = process.env.SEALQL_BENCH_OUTPUT_DIR ?? 'bench/results/2026-09-27-standard-next-sqlplan';
const report: any[] = [];
let authenticated = 0;
const originalOpen = sealer.open.bind(sealer);
sealer.open = async (...args) => { authenticated++; return originalOpen(...args); };
async function measure(fn: () => Promise<any[]>) {
  const events: Event[] = [];
  setEvents(events); authenticated = 0;
  const start = performance.now();
  try {
    const rows = await fn();
    return { rows, totalMs: performance.now() - start, sqlMs: events.reduce((sum, event) => sum + event.sqlMs, 0),
      sqlCalls: events.length, candidates: events.filter(event => /_seal_index/i.test(event.text)).reduce((sum, event) => sum + event.rows, 0), authenticatedFields: authenticated };
  } finally { setEvents(null); }
}
try {
  await guard();
  await mkdir(outputDir, { recursive: true });
  const sourceRows = (await query(`select address_plain from ${source}.customers where scope_id=$1`, [scopeId])).rows;
  assert.equal(sourceRows.length, 100000);
  for (const row of sourceRows) {
    const chars = Array.from(normalizeText(row.address_plain, 'legacy-text-v1').replace(/\s+/g, ''));
    const pieces = new Set<string>();
    for (const width of [2, 3, 4]) for (let i = 0; i + width <= chars.length; i++) pieces.add(chars.slice(i, i + width).join(''));
    for (const piece of pieces) counts.set(piece, (counts.get(piece) ?? 0) + 1);
  }
  const chosen = targets.map(target => {
    const candidates = [...counts].filter(([term, count]) => count >= Math.max(1, target / 2) && count <= target * 2 && !/^\d+$/.test(term) && !/[%_\\]/.test(term));
    candidates.sort((a, b) => Math.abs(Math.log(a[1] / target)) - Math.abs(Math.log(b[1] / target)) || a[0].localeCompare(b[0]));
    assert(candidates.length, `no substring near ${target}`);
    return { target, term: candidates[0][0], hits: candidates[0][1] };
  });
  chosen.push({ target: 16574, term: '세종대로', hits: counts.get('세종대로') ?? 0 });
  for (const item of chosen) item.hits = Number((await query(`select count(*) n from ${source}.customers where scope_id=$1 and address_norm like '%'||$2||'%'`, [scopeId, item.term])).rows[0].n);
  console.log(JSON.stringify({ rows: sourceRows.length, terms: chosen }));
  for (const item of chosen) {
    const sql = `select id,${fields.map(field => `${field}_plain as ${field}`).join(',')} from ${source}.customers where scope_id=$1 and address_norm like '%'||$2||'%' order by id limit 20`;
    const plain = () => query(sql, [scopeId, item.term]).then(result => result.rows);
    const expected = await plain();
    const paths: Record<string, () => Promise<any[]>> = { plain };
    for (const skip of process.env.SEALQL_BENCH_SKIP_ONLY === '1' ? [true] : [false, true]) {
      const b = binding('customers', skip);
      const stored = Object.entries(b.model.fields).flatMap(([field, spec]) => profiles(b.model.id, field, spec));
      const compiled = await compileSearch({ op: 'contains', field: 'address', value: item.term }, b.definition, stored, sealer.ring(b.model.id), scopeId);
      const original = b.repo.repository.binding.rows.candidates;
      let activeMode: Mode = 'direct';
      if (process.env.SEALQL_SWEEP_PRODUCT_ONLY !== '1') b.repo.repository.binding.rows.candidates = (executor, args) => {
        const statement = candidateStatement(b.definition, b.storage, scopeId, compiled,
          activeMode === 'direct' ? undefined : { limit: args.limit, after: args.after?.id });
        // Change only the literal prefix cap in this benchmark's rendered statement.
        if (activeMode !== 'direct' && activeMode !== 256) {
          assert(statement.text.includes('limit 256'));
          statement.text = statement.text.replace('limit 256', `limit ${activeMode}`);
        }
        return original(executor, { ...args, candidateSql: statement });
      };
      for (const mode of process.env.SEALQL_SWEEP_PRODUCT_ONLY === '1' ? [256 as Mode] : modes) {
        const label = process.env.SEALQL_SWEEP_PRODUCT_ONLY === '1' ? (skip ? 'skip' : 'next') : `${skip ? 'skip' : 'next'}_${mode}`;
        paths[label] = async () => { activeMode = mode; return (await b.repo.findMany({ match: f => f.address.contains(item.term), select, limit: 20,
          budgets: { ...(process.env.SEALQL_SWEEP_BATCH ? { batch: Number(process.env.SEALQL_SWEEP_BATCH) } : {}), maxCandidates: 20000, fetchBytes: 32 * 1024 * 1024, decryptedBytes: 32 * 1024 * 1024, resultBytes: 32 * 1024 * 1024, deadlineMs: 30000 } })).items; };
      }
    }
    for (const [label, fn] of Object.entries(paths)) same(await fn(), expected, `${item.term}/${label}/initial`);
    for (let i = 0; i < 2; i++) for (const fn of Object.values(paths)) await fn();
    const runs: Record<string, any[]> = Object.fromEntries(Object.keys(paths).map(label => [label, []]));
    for (let i = 0; i < 7; i++) {
      const names = Object.keys(paths); if (i % 2) names.reverse();
      for (const label of names) {
        const result = await measure(paths[label]); same(result.rows, expected, `${item.term}/${label}/${i}`);
        runs[label].push({ ...result, rows: undefined, returned: result.rows.length });
      }
    }
    const summary = Object.fromEntries(Object.entries(runs).map(([label, samples]) => [label,
      Object.fromEntries(['totalMs', 'sqlMs', 'sqlCalls', 'candidates', 'authenticatedFields', 'returned'].map(key => [key, median(samples.map(sample => sample[key]))]))]));
    report.push({ ...item, summary, runs });
    console.log(JSON.stringify({ target: item.target, hits: item.hits, term: item.term, summary }));
    await writeFile(`${outputDir}/sweep.json`, JSON.stringify({ sourceRows: sourceRows.length, chosen, report }, null, 2) + '\n');
  }
} finally { await pool.end(); }
