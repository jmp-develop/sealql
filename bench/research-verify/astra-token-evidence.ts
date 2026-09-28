/** Independent correctness experiments. No timing claims, no DB writes. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { profiles, searchPieces, searchTokens, normalizeText, type SearchProfile } from '../../src/core/search-tokens.js';
import { Sealer } from '../../src/core/field-cipher.js';
import { hex } from '../../src/core/bytes.js';

const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1 });
let fixture: { id: string; scope_id: string; memo_plain: string; company_plain: string }[];
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  await pool.query('begin read only');
  fixture = (await pool.query('select id, scope_id, memo_plain, company_plain from bench_realistic_100k.customers order by id limit 2000')).rows;
  await pool.query('commit');
} finally { await pool.end(); }
assert.equal(fixture.length, 2000);

const spec = { type: 'text' as const, search: { exact: true as const, substring: { skipGrams: true, wordBoundary: true } } };
const [exact, sub] = profiles('research-verify', 'text', spec);
const ring = { keyScopeId: 'global', key: new Uint8Array(32).fill(91) };
const scope = 'memory';
const cache = { profiles: new Map<string, Promise<CryptoKey>>() };
const signature = (p: SearchProfile, s: string) => searchPieces(p, s).map(hex).sort().join(',');
const productTokens = (p: SearchProfile, s: string, op: 'write' | 'contains' | 'startsWith' | 'endsWith' = 'write') => searchTokens(ring, scope, p, searchPieces(p, s, op), cache);
const subset = (small: Iterable<string>, big: Set<string>) => [...small].every(t => big.has(t));

// Exhaustive finite mathematical model; these strings never enter the DB.
let pair: { a: string; b: string; length: number } | undefined;
for (let length = 2; length <= 12 && !pair; length++) {
  const seen = new Map<string, string>();
  for (let i = 0; i < 2 ** length; i++) {
    const s = i.toString(2).padStart(length, '0').replaceAll('0', 'a').replaceAll('1', 'b');
    const sig = signature(sub, s), prior = seen.get(sig);
    if (prior && prior !== s) { pair = { a: prior, b: s, length }; break; }
    seen.set(sig, s);
  }
}
assert.ok(pair);
const aTokens = await productTokens(sub, pair.a), bTokens = await productTokens(sub, pair.b);
assert.deepEqual(aTokens, bTokens);
const qTokens = await productTokens(sub, pair.a, 'contains');
assert.ok(subset(qTokens, new Set(bTokens)));
assert.ok(!pair.b.includes(pair.a));
const structural = { ...pair, query: pair.a, aTruth: true, bTruth: false,
  sameRawPieceSet: true, sameAllProductTokens: true, sameUtf8Length: true,
  allTokenCount: aTokens.length, queryTokenCount: qTokens.length,
  protectionsIncluded: ['adjacent', 'skip', 'start', 'end', 'word-start', 'word-end'] };

// Even an additional 16-bit exact profile need not separate full substring signatures.
const combinedSeen = new Map<string, string>();
let combinedWitness: { a: string; b: string; length: number; exactToken: string; allSubstringTokens: string[] } | undefined;
for (let i = 0; i < 65536; i++) {
  const value = i.toString(2).padStart(16, '0').replaceAll('0', 'a').replaceAll('1', 'b');
  const exactToken = (await productTokens(exact, value))[0];
  const sig = `${signature(sub, value)}:${exactToken}`;
  const prior = combinedSeen.get(sig);
  if (prior) {
    const allSubstringTokens = await productTokens(sub, value);
    assert.deepEqual(allSubstringTokens, await productTokens(sub, prior));
    assert.notEqual(prior, value);
    combinedWitness = { a: prior, b: value, length: 16, exactToken, allSubstringTokens };
    break;
  }
  combinedSeen.set(sig, value);
}
assert.ok(combinedWitness, 'Expected a combined-profile witness in this fixed mathematical enumeration');

// Full-domain certification is a mathematical exception to "tokens can never prove true".
const domain = Array.from({ length: 256 }, (_, i) => i.toString(2).padStart(8, '0').replaceAll('0', 'a').replaceAll('1', 'b'));
const classes = new Map<string, string[]>();
for (const value of domain) { const sig = (await productTokens(sub, value)).join(','); const c = classes.get(sig) ?? []; c.push(value); classes.set(sig, c); }
const boundedQuery = 'aba';
const boundedQ = await productTokens(sub, boundedQuery, 'contains');
let certainTrue = 0, certainFalse = 0, ambiguous = 0, positiveCandidates = 0;
for (const [sig, values] of classes) {
  if (!subset(boundedQ, new Set(sig.split(',')))) continue;
  positiveCandidates += values.length;
  const yes = values.filter(s => s.includes(boundedQuery)).length;
  if (yes === values.length) certainTrue += values.length;
  else if (yes === 0) certainFalse += values.length;
  else ambiguous += values.length;
}
assert.equal(certainTrue + certainFalse + ambiguous, positiveCandidates);

const raw = await readFile('.local/ratings.txt', 'utf8');
const reviews = raw.split(/\r?\n/).slice(1).map(line => {
  const first = line.indexOf('\t'), last = line.lastIndexOf('\t');
  return first >= 0 && last > first ? line.slice(first + 1, last) : '';
}).filter(Boolean).slice(0, 5000);
const normalized = reviews.map(s => normalizeText(s, 'legacy-text-v1'));
const pieceMap = new Map<string, Uint8Array>();
for (const value of reviews) for (const p of searchPieces(sub, value)) pieceMap.set(hex(p), p);
const entries = [...pieceMap], tokenMap = new Map<string, string>();
let cursor = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (cursor < entries.length) { const [id, p] = entries[cursor++]; tokenMap.set(id, (await searchTokens(ring, scope, sub, [p], cache))[0]); }
}));
const rows = reviews.map(value => {
  const rawPieces = searchPieces(sub, value).map(hex);
  return { pieces: new Set(rawPieces), tokens: new Set(rawPieces.map(p => tokenMap.get(p)!)) };
});
for (let i = 0; i < Math.min(rows.length, 12); i++) assert.deepEqual([...rows[i].tokens].sort(), (await productTokens(sub, reviews[i])).sort());
const frequent = (length: number) => {
  const freq = new Map<string, number>();
  for (const s of normalized) {
    const cs = Array.from(s), grams = new Set<string>();
    for (let i = 0; i + length <= cs.length; i++) grams.add(cs.slice(i, i + length).join(''));
    for (const gram of grams) freq.set(gram, (freq.get(gram) ?? 0) + 1);
  }
  return [...freq].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(([s]) => s);
};
const corpus: object[] = [];
for (const query of [...frequent(2), ...frequent(3)]) {
  for (const op of ['contains', 'startsWith', 'endsWith'] as const) {
    const qp = searchPieces(sub, query, op).map(hex), qt = await productTokens(sub, query, op);
    let truth = 0, untruncatedCandidates = 0, candidates = 0, hashOnlyFalsePositives = 0, structuralFalsePositives = 0;
    let falseExample: string | undefined;
    for (let i = 0; i < rows.length; i++) {
      const yes = op === 'contains' ? normalized[i].includes(query) : op === 'startsWith' ? normalized[i].startsWith(query) : normalized[i].endsWith(query);
      const pieces = subset(qp, rows[i].pieces), tokens = subset(qt, rows[i].tokens);
      if (yes) { truth++; assert.ok(pieces && tokens); }
      if (pieces) untruncatedCandidates++;
      if (tokens) candidates++;
      if (tokens && !yes) {
        if (pieces) structuralFalsePositives++; else hashOnlyFalsePositives++;
        falseExample ??= reviews[i].slice(0, 120);
      }
    }
    assert.equal(candidates - truth, hashOnlyFalsePositives + structuralFalsePositives);
    corpus.push({ query, op, truth, untruncatedCandidates, candidates, hashOnlyFalsePositives, structuralFalsePositives, falseExample });
  }
}

// Exact-token collision witness from actual corpus, with equal visible ciphertext length.
const buckets = new Map<string, string>();
let exactCollision: object | undefined;
for (const value of reviews) {
  const normalizedValue = normalizeText(value, exact.normalizer);
  const token = (await productTokens(exact, value))[0];
  const sig = `${Buffer.byteLength(value)}:${token}`, prior = buckets.get(sig);
  if (prior && normalizeText(prior, exact.normalizer) !== normalizedValue) {
    exactCollision = { a: prior, b: value, token, byteLength: Buffer.byteLength(value), distinctNormalizedValues: true };
    break;
  }
  buckets.set(sig, value);
}

// Integrity counterexample: companion membership alone cannot authenticate a field.
const sealer = new Sealer({ key: ring.key });
const context = { modelId: 'research-verify', fieldId: 'text', keyScopeId: 'global', scopeId: fixture[0].scope_id, rowId: fixture[0].id, spec };
const sealed = await sealer.seal(fixture[0].memo_plain, context, ring);
const altered = sealed.slice(); altered[altered.length - 1] ^= 1;
let tamperRejected = false;
try { await sealer.open(altered, context, ring); } catch (error) { tamperRejected = (error as { code?: string }).code === 'AUTHENTICATION_FAILED'; }
assert.ok(tamperRejected);
const output = {
  method: 'Correctness-only; product HMAC functions; no SQL writes, no performance timing, no measurement lock needed',
  source: { fixtureRows: fixture.length, corpusRows: reviews.length, corpusSha256: createHash('sha256').update(raw).digest('hex'), corpusRange: 'first 5000 nonempty reviews' },
  structural, combinedWitness,
  boundedDomain: { alphabet: 'ab', exactLength: 8, query: boundedQuery, domainSize: domain.length, classes: classes.size, positiveCandidates, certainTrue, certainFalse, ambiguous,
    caveat: 'Requires exhaustive enforced domain and authentic index binding; does not establish current product DB trust' },
  exactCollision: exactCollision ?? null,
  integrity: { ciphertextTagBitFlipped: true, tokenCluesUnchanged: true, currentSealerRejected: tamperRejected },
  corpus,
};
await mkdir('bench/results/2026-09-28-count-verify', { recursive: true });
await writeFile('bench/results/2026-09-28-count-verify/astra-token-evidence.json', JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ structural, combinedWitness, boundedDomain: output.boundedDomain, exactCollisionFound: !!exactCollision,
  corpusQueries: corpus.length, integrity: output.integrity }, null, 2));
