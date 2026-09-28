// Continues the mongo2.qe load from max(_id)+1 to 100,000 (4 clients, insertMany 500). Appends progress to load-continue.log.
import fs from 'fs';
import { MongoClient, ClientEncryption } from 'mongodb';
import { connect, URI, keyVaultNamespace, kmsProviders } from './lib.mjs';
import { getKeys2, row2doc, encDoc2 } from './m2-lib.mjs';
const LOG = 'load-continue.log', log = s => fs.appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`);
const docs = JSON.parse(fs.readFileSync('customers-norm.json', 'utf8')).map(row2doc);
const { plain, enc, ce } = await connect(); const keys = await getKeys2(ce, plain);
const coll = plain.db('mongo2').collection('qe');
const start = (await coll.find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).toArray())[0]?._id ?? 0, cnt = await coll.countDocuments();
log(`start max_id=${start} count=${cnt} contiguous=${start === cnt}`);
if (start !== cnt) throw new Error('qe is not a contiguous prefix');
const clients = await Promise.all([0, 1, 2, 3].map(async () => { const c = new MongoClient(URI, { autoEncryption: { keyVaultNamespace, kmsProviders, bypassQueryAnalysis: true } }); await c.connect(); return { c, ce: new ClientEncryption(c, { keyVaultNamespace, kmsProviders }) }; }));
let next = start, done = 0; const t0 = performance.now();
await Promise.all(clients.map(async w => {
  while (next < docs.length) {
    const i = next; next += 500;
    const batch = await Promise.all(docs.slice(i, i + 500).map(d => encDoc2(w.ce, keys, d)));
    await w.c.db('mongo2').collection('qe').insertMany(batch);
    done += batch.length; const s = (performance.now() - t0) / 1000;
    log(`batch@${i} added=${done} total~${start + done} wall=${s.toFixed(1)}s docs/s=${(done / s).toFixed(1)}`);
  }
}));
const final = await coll.countDocuments();
log(`load complete N=${final} added=${done} wall=${((performance.now() - t0) / 1000).toFixed(1)}s docs/s=${(done / (performance.now() - t0) * 1000).toFixed(1)}`);
await Promise.all(clients.map(x => x.c.close())); await plain.close(); await enc.close();
