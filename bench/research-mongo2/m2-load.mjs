// Usage: node m2-load.mjs <stopAtISO> ; loads mongo2.plain (100k) and mongo2.qe (time-boxed, 4 parallel clients, insertMany 500)
import fs from 'fs';
import { MongoClient, ClientEncryption } from 'mongodb';
import { connect, URI, keyVaultNamespace, kmsProviders } from './lib.mjs';
import { getKeys2, fields2, row2doc, encDoc2 } from './m2-lib.mjs';
const stopAt = Date.parse(process.argv[2]);
const rows = JSON.parse(fs.readFileSync('customers-norm.json', 'utf8'));
const cp = s => Array.from(s ?? '').length;
const out = { at: new Date().toISOString(), rows: rows.length, truncated: { memo: rows.filter(r => cp(r.memo_norm) > 60).length, address: rows.filter(r => cp(r.address_norm) > 60).length }, nulls: Object.fromEntries(['company_norm','phone_norm','name_norm','email_norm','memo_norm','address_norm'].map(k => [k, rows.filter(r => r[k] == null).length])) };
console.log(JSON.stringify(out));
const docs = rows.map(row2doc);
const { plain, enc, ce } = await connect();
const keys = await getKeys2(ce, plain);
const db = plain.db('mongo2');
await db.collection('plain').drop().catch(() => {});
let t = performance.now();
for (let i = 0; i < docs.length; i += 500) await db.collection('plain').insertMany(docs.slice(i, i + 500).map(d => ({ ...d })));
out.plainLoadMs = performance.now() - t;
t = performance.now();
for (const f of ['company', 'phone', 'name', 'email']) await db.collection('plain').createIndex({ [f]: 1 });
out.plainIndexMs = performance.now() - t;
console.log('plain', out.plainLoadMs, out.plainIndexMs);
const ef = fields2(keys);
await enc.db('mongo2').dropCollection('qe', { encryptedFields: ef }).catch(() => {});
await enc.db('mongo2').createCollection('qe', { encryptedFields: ef });

out.encryptedFields = ef.fields.map(f => ({ path: f.path, ...f.queries }));
const clients = await Promise.all([0, 1, 2, 3].map(async () => { const c = new MongoClient(URI, { autoEncryption: { keyVaultNamespace, kmsProviders, bypassQueryAnalysis: true } }); await c.connect(); return { c, ce: new ClientEncryption(c, { keyVaultNamespace, kmsProviders }) }; }));
let next = 0, doneDocs = 0; const B = 500; const t0 = performance.now(); const log = [];
async function worker(w) {
  while (Date.now() < stopAt && next < docs.length) {
    const i = next; next += B;
    const batch = await Promise.all(docs.slice(i, i + B).map(d => encDoc2(w.ce, keys, d)));
    await w.c.db('mongo2').collection('qe').insertMany(batch);
    doneDocs += batch.length; const wall = performance.now() - t0;
    log.push({ from: i, done: doneDocs, wallMs: wall }); console.log(`qe done=${doneDocs} batch@${i} wall=${(wall / 1000).toFixed(1)}s docs/s=${(doneDocs / wall * 1000).toFixed(1)}`);
  }
}
await Promise.all(clients.map(worker));
out.qeWallMs = performance.now() - t0; out.N = doneDocs; out.issued = next; out.qeDocsPerSec = doneDocs / out.qeWallMs * 1000; out.batches = log;
out.qeCount = await db.collection('qe').countDocuments(); out.qeMaxN = (await db.collection('qe').find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).toArray())[0]?._id;
out.plainDocsPerSec = docs.length / out.plainLoadMs * 1000;
console.log('DONE', JSON.stringify({ ...out, batches: undefined }));
fs.writeFileSync('out/m2-load.json', JSON.stringify(out, null, 1));
await Promise.all(clients.map(x => x.c.close())); await plain.close(); await enc.close();
