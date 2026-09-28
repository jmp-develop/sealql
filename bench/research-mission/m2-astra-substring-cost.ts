import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Read-only arithmetic over an existing corpus. No DB, cryptography benchmark,
// generated records, timing measurement, or leakage experiment.
const input = readFileSync('.local/ratings.txt');
const rows = input.toString('utf8').split(/\r?\n/).slice(1)
  .filter(line => line.length > 0).map(line => line.split('\t')[1] ?? '');
const sumSubstrings = (n: number, lo: number, hi: number) => {
  const upper = Math.min(n, hi);
  return upper < lo ? 0 : (upper - lo + 1) * (2 * n - lo - upper + 2) / 2;
};
const percentile = (sorted: number[], q: number) => sorted[Math.ceil(q * sorted.length) - 1];
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  return { rows: values.length, sum, mean: sum / values.length,
    p50: percentile(sorted, .5), p95: percentile(sorted, .95), max: sorted.at(-1) };
};
const lengths = rows.map(s => [...s].length);
const accepted = rows.filter(s => [...s].length <= 60);
const tagCounts = accepted.map(s => {
  // Port of arithmetic in libmongocrypt mc-text-search-str-encode.c:
  // 1 exact tag, plus substring slots padded to byte-length bucket capped by mlen.
  const padded = Math.min(60, 16 * Math.floor((Buffer.byteLength(s) + 5 + 16) / 16) - 5);
  return 1 + sumSubstrings(padded, 2, 10);
});
const hypotheticalUnbounded = rows.map(s => 1 + sumSubstrings([...s].length, 2, [...s].length));
const currentSourceRows = rows.filter(s => [...s].length <= 50);
const currentSourceTags = currentSourceRows.map(s => 1 + sumSubstrings(
  Math.min(50, 16 * Math.floor((Buffer.byteLength(s) + 21) / 16) - 5), 2, 6));
const result = {
  kind: 'corpus arithmetic; NOT MongoDB run, disk size, latency, or security measurement',
  input: '.local/ratings.txt', sha256: createHash('sha256').update(input).digest('hex'),
  params: { minQueryLength: 2, maxQueryLength: 10, maxFieldLength: 60,
    caseSensitive: true, diacriticSensitive: true, prefix: false, suffix: false },
  source: 'https://github.com/mongodb/libmongocrypt/blob/3872fc2ad0d1c712d43aaa26eefb49da64e61a62/src/mc-text-search-str-encode.c',
  codepointLengths: stats(lengths), rejectedOver60: lengths.filter(n => n > 60).length,
  rejectedOver60Fraction: lengths.filter(n => n > 60).length / rows.length,
  acceptedTagSlots: stats(tagCounts),
  currentServerSourceScenario: {
    warning: 'Current source constants, NOT a verified r9.0.0 release or MongoDB execution',
    source: 'https://github.com/mongodb/mongo/blob/da457d58ef2415351ce6a2cc4a65c1bcedf8b725/src/mongo/crypto/fle_crypto.h#L1049',
    maxFieldLength: 50, minQueryLength: 2, maxQueryLength: 6,
    rejectedOver50: lengths.filter(n => n > 50).length,
    rejectedOver50Fraction: lengths.filter(n => n > 50).length / rows.length,
    acceptedTagSlots: stats(currentSourceTags),
  },
  derivedBytesNotDisk: { safeContentRawTags32Bytes: tagCounts.reduce((a,b)=>a+b,0)*32,
    encryptedMetadata96Bytes: tagCounts.reduce((a,b)=>a+b,0)*96,
    note: 'Uncompressed fields only; excludes BSON, encrypted value, ESC/ECOC, indexes and WAL.' },
  hypotheticalAllLengthsNoPaddingOccurrenceSlots: stats(hypotheticalUnbounded),
  examplesAnalyticalNotGeneratedData: [60, 100, 1000].map(n => ({ length: n,
    substringSlots2to10: sumSubstrings(n,2,10),
    allSubstringSlots2toN: sumSubstrings(n,2,n) }))
};
mkdirSync('bench/results/2026-09-28-mission', { recursive: true });
writeFileSync('bench/results/2026-09-28-mission/m2-astra-substring-cost.json', JSON.stringify(result, null, 2)+'\n');
console.log(JSON.stringify(result, null, 2));
