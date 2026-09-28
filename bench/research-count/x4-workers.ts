/**
 * X4 Cloudflare Workers check (local workerd via the repo's miniflare dev dependency, no global tools):
 * WebCrypto AES-GCM decrypt per field (current format) vs X4 pure-JS HMAC-SHA-256 per field vs X4 CBC single-call batch decrypt,
 * 42,352 fields = and2 certificate (company + memo of the 21,176 matching fixture rows, read-only DB). Same ops also run in Node.
 * Timing: host wall time of one dispatchFetch per op minus the median no-op request (workerd timers may be frozen during
 * execution), plus the in-worker performance.now()/Date.now() deltas as reported. Warm-up 2 + 7, medians, rotated order.
 * Usage: rtk proxy npx tsx bench/research-count/x4-workers.ts
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import pg from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { combos, plainWhere } from '../verify-native/r8-cases.js';
import { OUT, json, median } from './x2-lib.js';
import { prepare, ops } from './x4-workers-ops.js';
import { lock, unlock, scopeA } from './x4-lib.js';

const ro = new pg.Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1, options: '-c default_transaction_read_only=on' });
await assertDisposable(ro); assert.equal(Number((await ro.query('show port')).rows[0].port), 56439);
const and2 = combos.find(c => c.name === 'and2')!; const params: unknown[] = [scopeA];
const rows = (await ro.query(`select id::text, company_plain, memo_plain from bench_realistic_100k.customers where scope_id=$1 and ${plainWhere(and2.node, params)} order by id`, params)).rows;
await ro.end();
const items = rows.flatMap(r => [{ row: r.id, field: 'company', value: r.company_plain }, { row: r.id, field: 'memo', value: r.memo_plain }]);
assert.equal(items.length, 42352);
const res: any = { startedAt: new Date().toISOString(), fields: items.length, avgPlainBytes: items.reduce((a, x) => a + Buffer.byteLength(x.value), 0) / items.length };
const names = Object.keys(ops).filter(n => n !== 'noop');
let mf: Miniflare | undefined;
try {
  const bundle = await build({ entryPoints: ['bench/research-count/x4-workers-entry.ts'], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022' });
  mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30' });
  const call = async (op: string, body?: unknown) => { const s = performance.now(); const r = await mf!.dispatchFetch(`https://x4.test/${op}`, body ? { method: 'POST', body: JSON.stringify(body) } : {}); const txt = await r.text(); const wall = performance.now() - s; if (r.status !== 200) throw Error(`${op}: ${r.status} ${txt}`); return { wall, ...JSON.parse(txt) }; };
  res.workerdPrepare = await call('prepare', { items, scope: scopeA });
  res.nodePrepare = await prepare(items, scopeA);
  await lock('workers');
  try {
    const w: Record<string, any[]> = Object.fromEntries(['noop', ...names].map(n => [n, []])); const nd: Record<string, number[]> = Object.fromEntries(names.map(n => [n, []]));
    for (let i = 0; i < 9; i++) {
      for (const n of ['noop', ...names.map((_, k) => names[(k + i) % names.length])]) { const r = await call(n); assert(n === 'noop' || r.n === items.length); if (i >= 2) w[n].push(r); }
      for (const n of names.map((_, k) => names[(k + i) % names.length])) { const s = performance.now(); const k = await ops[n](); const ms = performance.now() - s; assert.equal(k, items.length); if (i >= 2) nd[n].push(ms); }
    }
    const noop = median(w.noop.map(x => x.wall));
    res.noopWallMs = +noop.toFixed(3);
    res.results = Object.fromEntries(names.map(n => { const wall = median(w[n].map(x => x.wall)) - noop;
      return [n, { workerdMs: +wall.toFixed(2), workerdUsPerField: +(1000 * wall / items.length).toFixed(3), workerdInPerfMs: +median(w[n].map(x => x.inWorkerPerfMs)).toFixed(2), workerdInDateMs: median(w[n].map(x => x.inWorkerDateMs)),
        nodeMs: +median(nd[n]).toFixed(2), nodeUsPerField: +(1000 * median(nd[n]) / items.length).toFixed(3) }]; }));
    res.raw = { workerd: w, node: nd };
  } finally { unlock(); }
  res.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}/x4-workers.json`, json(res)); console.log(JSON.stringify({ prepare: res.workerdPrepare, noop: res.noopWallMs, results: res.results }, null, 1));
} finally { await mf?.dispose(); }
