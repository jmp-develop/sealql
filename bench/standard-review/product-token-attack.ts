/** Mechanical token-dump attacks on the product framing; no DB or AI interpretation.
 * Usage: node --import tsx bench/standard-review/product-token-attack.ts .local/ratings.txt
 */
import { createHmac, hkdfSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { frame, hex } from '../../src/core/bytes.js';
import { descriptorBytes, normalizeText, profiles, searchPieces, type SearchProfile } from '../../src/core/search-tokens.js';

const path = process.argv[2];
if (!path) throw new Error('Pass the local ratings.txt path');
const lines = readFileSync(path, 'utf8').split('\n').slice(1).map(line => line.split('\t')[1]).filter((v): v is string => !!v && Array.from(v).length >= 2);
const victim = lines.slice(0, 20000), reference = lines.slice(20000, 40000);
if (victim.length !== 20000 || reference.length !== 20000) throw new Error('Need 40,000 nonempty reviews');
const root = Buffer.alloc(32, 93), scopeId = 'attack-scope';
const spec = (skipGrams: boolean) => ({ type: 'text' as const, search: { substring: { wordBoundary: true, skipGrams } } });
const make = (skipGrams: boolean) => {
  const p = profiles('review', 'text', spec(skipGrams))[0];
  const key = Buffer.from(hkdfSync('sha384', root, Buffer.alloc(0), Buffer.from(frame(['sealql/index/v3', 'global', descriptorBytes(p)])), 48));
  const scopeDigest = createHmac('sha384', key).update(frame(['scope', scopeId])).digest();
  const scopePrefix = BigInt(scopeDigest.readUInt32BE(0));
  const memo = new Map<string, string>();
  const token = (piece: Uint8Array) => {
    const label = hex(piece); let cached = memo.get(label);
    if (!cached) {
      const digest = createHmac('sha384', key).update(frame(['value', scopeId, piece])).digest();
      const bits = (digest.readUInt32BE(0) >>> 16) * 65536;
      cached = BigInt.asIntN(64, (scopePrefix << 32n) | BigInt(bits >>> 0)).toString(); memo.set(label, cached);
    }
    return cached;
  };
  const pieces = (value: string) => searchPieces(p, value).map(hex);
  const query = (value: string) => searchPieces(p, value, 'contains').map(token);
  return { p, token: (label: string) => token(Buffer.from(label, 'hex')), pieces, query };
};
function decodePiece(label: string): { kind: string; value: string } {
  const bytes = Buffer.from(label, 'hex');
  const kindLength = bytes.readUInt32BE(4), kind = bytes.subarray(8, 8 + kindLength).toString('utf8');
  const valueLength = bytes.readUInt32BE(8 + kindLength);
  return { kind, value: bytes.subarray(12 + kindLength, 12 + kindLength + valueLength).toString('utf8') };
}
function run(skipGrams: boolean) {
  const alg = make(skipGrams);
  const truth = victim.map(v => [...new Set(alg.pieces(v))]);
  const ref = reference.map(v => [...new Set(alg.pieces(v))]);
  const frequency = new Map<string, number>(), tokenTruth = new Map<string, Map<string, number>>();
  for (const row of truth) for (const piece of row) {
    const t = alg.token(piece); frequency.set(t, (frequency.get(t) ?? 0) + 1);
    const byPiece = tokenTruth.get(t) ?? new Map<string, number>();
    byPiece.set(piece, (byPiece.get(piece) ?? 0) + 1); tokenTruth.set(t, byPiece);
  }
  const refFreq = new Map<string, number>();
  for (const row of ref) for (const piece of row) refFreq.set(piece, (refFreq.get(piece) ?? 0) + 1);
  const rankedTokens = [...frequency].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const rankedPieces = [...refFreq].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const freqGuess = new Map(rankedTokens.map((t, i) => [t, rankedPieces[i]]));
  const score = (guess: Map<string, string>, known: Set<number>) => {
    let correct = 0, total = 0, mostly = 0, unknown = 0;
    truth.forEach((row, i) => {
      let rowCorrect = 0;
      for (const piece of row) { total++; if (guess.get(alg.token(piece)) === piece) { correct++; rowCorrect++; } }
      if (!known.has(i)) { unknown++; if (row.length && rowCorrect / row.length >= .8) mostly++; }
    });
    return { decodedOccurrencePct: +(100 * correct / total).toFixed(2), mostlyDecodedUnknownRowsPct: +(100 * mostly / unknown).toFixed(2) };
  };
  const known = new Set<number>(); let seed = 99;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  while (known.size < 1000) known.add(Math.floor(random() * victim.length));
  const signatures = new Map<string, number[]>(), pieceSignatures = new Map<string, number[]>();
  truth.forEach((row, i) => { if (!known.has(i)) return; for (const piece of row) {
    const t = alg.token(piece);
    (signatures.get(t) ?? signatures.set(t, []).get(t)!).push(i);
    (pieceSignatures.get(piece) ?? pieceSignatures.set(piece, []).get(piece)!).push(i);
  } });
  const bySignature = new Map<string, string[]>();
  for (const [piece, rows] of pieceSignatures) {
    const sig = rows.join(',');
    (bySignature.get(sig) ?? bySignature.set(sig, []).get(sig)!).push(piece);
  }
  const knownGuess = new Map<string, string>();
  for (const [token, rows] of signatures) {
    const matches = bySignature.get(rows.join(','));
    if (matches?.length === 1) knownGuess.set(token, matches[0]);
  }
  let skipTotal = 0, skipDecoded = 0, skipWithDecodedAdjacentPath = 0;
  if (skipGrams) truth.forEach((row, i) => {
    if (known.has(i)) return;
    const decoded = row.map(piece => knownGuess.get(alg.token(piece))).filter((piece): piece is string => !!piece).map(decodePiece);
    const adjacent = new Set(decoded.filter(piece => piece.kind === 'adjacent').map(piece => piece.value));
    for (const piece of row) {
      const original = decodePiece(piece);
      if (original.kind !== 'skip') continue;
      skipTotal++;
      const guess = knownGuess.get(alg.token(piece));
      if (guess !== piece) continue;
      skipDecoded++;
      const chars = Array.from(original.value);
      if (chars.length === 2 && [...adjacent].some(pair => Array.from(pair)[0] === chars[0] && adjacent.has(Array.from(pair)[1] + chars[1]))) skipWithDecodedAdjacentPath++;
    }
  });
  const search = ['영화', '서비스', '정말'].map(term => {
    const terms = new Set(alg.query(term));
    let candidates = 0, matches = 0;
    victim.forEach((row, i) => {
      const stored = new Set(truth[i].map(alg.token));
      if ([...terms].every(t => stored.has(t))) candidates++;
      if (normalizeText(row, 'legacy-text-v1').includes(term)) matches++;
    });
    return { term, candidates, matches, falsePositiveFactor: matches ? +(candidates / matches).toFixed(3) : null };
  });
  return { layout: skipGrams ? 'adjacent+skip+boundary' : 'adjacent+boundary', rows: victim.length,
    frequency: score(freqGuess, new Set()), knownRowsPct: 5, knownRow: score(knownGuess, known),
    skipConsistency: skipGrams ? { decodedSkipOccurrencePct: +(100 * skipDecoded / skipTotal).toFixed(2), confirmedByDecodedAdjacentPathPct: skipDecoded ? +(100 * skipWithDecodedAdjacentPath / skipDecoded).toFixed(2) : 0, decodedSkipOccurrences: skipDecoded } : undefined,
    search };
}
const result = { source: path, victimRows: victim.length, referenceRows: reference.length, seed: 99, layouts: [run(false), run(true)] };
console.log(JSON.stringify(result, null, 2));
writeFileSync('bench/results/standard-product-token-attack-fixed-key-2026-09-27.json', JSON.stringify(result, null, 2));
