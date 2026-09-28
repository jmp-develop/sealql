/**
 * Task 1c (m2-fable): combination "C-style exact match (per-occurrence tags + counter ledger) AND improved-B partial search
 * (m1-astra positional stamps, window 2)" — count only, plaintext = 1x. Reuses research_u.customers_ctag + esc (C, m2-fable)
 * and research_u.pb_astra_w2 (m1-astra). Read-only; lock respected (m1-astra has priority: if the lock is held we exit).
 * Run: rtk proxy npx tsx bench/research-task1/m2-fable-comb.ts
 */
import assert from 'node:assert/strict';
import { createHmac, hash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { normalizeText } from '../../src/core/search-tokens.js';
import { candidate as bCandidate } from '../research-unified/b-product.js';

const { Pool } = pg;
const S = 'research_u', OUT = 'bench/results/2026-09-29-task1', LOCK = '.local/research/measure.lock', SCOPE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 2, options: '-c statement_timeout=600000' });
await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
if (existsSync(LOCK)) { console.log('measure.lock held by', readFileSync(LOCK, 'utf8').trim(), '-> not measuring (m1-astra priority)'); await pool.end(); process.exit(0); }
writeFileSync(LOCK, 'm2-fable task1c ' + new Date().toISOString() + '\n', { flag: 'wx' });
const unlock = () => { if (existsSync(LOCK) && readFileSync(LOCK, 'utf8').startsWith('m2-fable task1c')) unlinkSync(LOCK); };
mkdirSync(OUT, { recursive: true });
const KEY = Buffer.alloc(32, 7);
const norm = (s: string) => normalizeText(s, 'legacy-text-v1');
// C exact-match token (m2-fable contract): token = sha256(prfKey || label), label = customers\0company\0e\0<norm value>
const cTok = (v: string) => hash('sha256', Buffer.concat([KEY, Buffer.from('customers\0company\0e\0' + norm(v))]), 'buffer') as Buffer;
const genTags = (i: number) => `array(select substr(digest($${i}::bytea || int4send(g), 'sha256'), 1, 8) from generate_series(1, coalesce((select n from ${S}.esc where tok = digest($${i}::bytea || 'esc'::bytea, 'sha256')), 0)) g)`;
// improved-B positional stamps, window 2 (m1-astra pb-astra.ts): key = HMAC(prfKey, scope\0customers\0field\0pb-w2\0piece)
const pbKey = (field: string, piece: string) => createHmac('sha256', KEY).update([SCOPE, 'customers', field, 'pb-w2', piece].join('\0')).digest();
function stampTest(field: string, term: string, params: unknown[]) {
  const c = Array.from(norm(term)); const tests: string[] = [];
  for (let off = 0; off + 2 <= c.length; off++) { params.push(pbKey(field, c.slice(off, off + 2).join(''))); tests.push(`(('x'||encode(substr(sha256($${params.length}::bytea||j.salt_${field}||int4send(g.p+${off})),1,8),'hex'))::bit(64)::bigint)=ANY(j.stamps_${field})`); }
  return `EXISTS(SELECT 1 FROM generate_series(0, j.n_${field}-${c.length}) AS g(p) WHERE ${tests.join(' AND ')})`;
}
const cases = [
  { name: 'company=서울서비스 담당 AND memo contains "upportcase" (10자, 흔함)', company: '서울서비스 담당', term: 'upportcase' },
  { name: 'company=서울서비스 담당 AND memo contains "약서검토완료zzxl" (10자, 드묾)', company: '서울서비스 담당', term: '약서검토완료zzxl' },
];
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const results: any[] = [];
try {
  for (const k of cases) {
    const plain = async () => Number((await pool.query(`select count(*) n from ${S}.pb_astra_plain p join ${S}.customers_plain c on c.id = p.id where c.company_norm = $1 and p.memo_norm like '%' || $2 || '%'`, [norm(k.company), norm(k.term)])).rows[0].n);
    // improved-B first narrows with the product's 16-bit candidate tokens (cs_memo), then checks positional stamps; C exact tags via id set
    const comb = async () => { const params: unknown[] = [cTok(k.company)]; const cand = await bCandidate({ op: 'contains', field: 'memo', value: k.term }, 'customers', params, 'j'); const st = stampTest('memo', k.term, params); return Number((await pool.query(`select count(*) n from ${S}.pb_astra_w2 j where ${cand} and ${st} and j.id in (select id from ${S}.customers_ctag where tag8 = any(${genTags(1)}))`, params)).rows[0].n); };
    const cOnly = async () => Number((await pool.query(`select count(*) n from (select id from ${S}.customers_ctag where tag8 = any(${genTags(1)})) x`, [cTok(k.company)])).rows[0].n);
    const pbOnly = async () => { const params: unknown[] = []; const cand = await bCandidate({ op: 'contains', field: 'memo', value: k.term }, 'customers', params, 'j'); const st = stampTest('memo', k.term, params); return Number((await pool.query(`select count(*) n from ${S}.pb_astra_w2 j where ${cand} and ${st}`, params)).rows[0].n); };
    const truth = await plain(); const cN = await cOnly(); const pbN = await pbOnly();
    const paths: Record<string, () => Promise<number>> = { plain, combination: comb };
    const runs: Record<string, number[]> = { plain: [], combination: [] }; const wrong: Record<string, string> = {};
    for (let i = 0; i < 10; i++) for (const n of (i % 2 ? ['combination', 'plain'] : ['plain', 'combination'])) { if (wrong[n]) continue; const t = performance.now(); const v = await paths[n](); const ms = performance.now() - t; if (v !== truth) { wrong[n] = '틀림(센 값 ' + v + ', 정답 ' + truth + ')'; continue; } if (i >= 3) runs[n].push(ms); }
    const row = { case: k.name, matches: truth, companyOnly: cN, memoOnly: pbN, plainMs: +median(runs.plain).toFixed(1), combinationMs: runs.combination.length ? +median(runs.combination).toFixed(1) : null, ratio: runs.combination.length ? +(median(runs.combination) / median(runs.plain)).toFixed(1) : null, wrong, sql: 1, appRows: 0, decrypts: 0 };
    console.log(JSON.stringify(row)); results.push(row);
  }
  writeFileSync(OUT + '/m2-fable-comb.json', JSON.stringify(results, null, 1));
  console.log('saved with candidate filter');
} finally { unlock(); await pool.end(); }
