// Task 2 (m1-fable): read a REAL MongoDB Queryable Encryption dump (mongo-lab copy, standalone read-only mongod) and
// compute what a backup-only attacker sees. Output: bench/results/2026-09-29-mongo2/t2-fable-mongo-dump.json
// Run: node bench/research-task2/t2-fable-mongo-dump.mjs <mongodb-uri> <path-to-mongo-lab-node_modules>
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const [uri, nm] = process.argv.slice(2);
const require = createRequire(nm.replace(/\\/g, '/') + '/');
const { MongoClient, Binary } = require('mongodb');
const OUT = 'bench/results/2026-09-29-mongo2'; mkdirSync(OUT, { recursive: true });
const c = new MongoClient(uri, { directConnection: true }); await c.connect();
const db = c.db('qe'); const res = { uri, collections: {}, tags: {}, esc: {}, ecoc: {}, lengths: {}, notes: [] };
for (const n of await db.listCollections().toArray()) res.collections[n.name] = await db.collection(n.name).estimatedDocumentCount();
const bytes = v => v instanceof Binary ? v.length() : v?.buffer ? v.buffer.length : (v?.length ?? 0);
// documents: __safeContent__ tags, ciphertext byte lengths, in natural (record) order
const docs = db.collection('customers').find({}, { projection: { _id: 1, id: 1, __safeContent__: 1, company: 1, memo: 1, name: 1 } });
const tagCount = new Map(); let n = 0; const perDoc = []; let plainMemoLen = null;
try { const p = c.db('plain').collection('customers'); if (await p.estimatedDocumentCount()) { plainMemoLen = new Map(); for await (const d of p.find({}, { projection: { id: 1, memo: 1, company: 1, name: 1 } })) plainMemoLen.set(d.id, { memoLen: Array.from(d.memo ?? '').length, company: d.company, name: d.name }); } } catch {}
for await (const d of docs) {
  n++; const tags = (d.__safeContent__ ?? []).map(t => Buffer.from(t.buffer ?? t).toString('hex'));
  for (const t of tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  const pl = plainMemoLen?.get(d.id);
  perDoc.push({ i: n, id: d.id, tags: tags.length, companyBytes: bytes(d.company), memoBytes: bytes(d.memo), nameBytes: bytes(d.name), plainMemoLen: pl?.memoLen ?? null, company: pl?.company ?? null });
}
let shared = 0, sharedMax = 0; for (const v of tagCount.values()) if (v > 1) { shared++; if (v > sharedMax) sharedMax = v; }
res.tags = { documents: n, distinctTags: tagCount.size, tagsTotal: [...tagCount.values()].reduce((a, b) => a + b, 0), tagsSharedByMoreThanOneDocument: shared, maxDocumentsPerTag: sharedMax };
// ESC / ECOC: ids are opaque; what is visible is their count and byte sizes
for (const [k, coll] of [['esc', 'enxcol_.customers.esc'], ['ecoc', 'enxcol_.customers.ecoc']]) {
  const col = db.collection(coll); const cnt = await col.estimatedDocumentCount(); const sample = await col.find({}).limit(3).toArray();
  res[k] = { documents: cnt, sampleShapes: sample.map(d => Object.fromEntries(Object.entries(d).map(([f, v]) => [f, v instanceof Binary ? `Binary(${v.length()} B)` : typeof v]))) };
}
// length leakage: ciphertext bytes vs plaintext memo length (CBC 16-byte padding => length known within 16 bytes), tag count vs length
const byLen = new Map(); for (const d of perDoc) { if (d.plainMemoLen === null) continue; const k = d.memoBytes; let g = byLen.get(k); if (!g) byLen.set(k, g = new Set()); g.add(d.plainMemoLen); }
const tagsByLen = new Map(); for (const d of perDoc) { if (d.plainMemoLen === null) continue; let g = tagsByLen.get(d.plainMemoLen); if (!g) tagsByLen.set(d.plainMemoLen, new Set()); tagsByLen.get(d.plainMemoLen).add(d.tags); }
res.lengths = { memoCiphertextByteValues: byLen.size, plainLengthsPerCiphertextLength: [...byLen].sort((a, b) => a[0] - b[0]).slice(0, 12).map(([b, s]) => [b, [...s].sort((x, y) => x - y)]), tagCountByPlainLength: [...tagsByLen].sort((a, b) => a[0] - b[0]).slice(0, 12).map(([l, s]) => [l, [...s].sort((x, y) => x - y)]), companyCiphertextBytes: [...new Set(perDoc.map(d => d.companyBytes))], nameCiphertextBytes: [...new Set(perDoc.map(d => d.nameBytes))].sort((a, b) => a - b).slice(0, 20) };
// company equality: do docs with the same plaintext company share any tag? (they must not, if tags are per-occurrence)
if (plainMemoLen) { const byCompany = new Map(); for (const d of perDoc) { if (!d.company) continue; let g = byCompany.get(d.company); if (!g) byCompany.set(d.company, g = 0); byCompany.set(d.company, g + 1); } res.companyDistribution = [...byCompany].sort((a, b) => b[1] - a[1]); }
res.notes.push('Tags are the server-side index entries (__safeContent__); a tag shared by >1 document would link those documents. ESC/ECOC ids are HMAC-derived and opaque without the key; only their counts and sizes are visible.');
writeFileSync(`${OUT}/t2-fable-mongo-dump.json`, JSON.stringify({ ...res, perDocSample: perDoc.slice(0, 5) }, null, 2) + '\n');
console.log(JSON.stringify({ collections: res.collections, tags: res.tags, esc: res.esc.documents, ecoc: res.ecoc.documents, lengths: res.lengths }));
await c.close();
