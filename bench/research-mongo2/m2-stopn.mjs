// After the load was stopped: N = qe count, contiguity check, rebuild mongo2.plain_n = plaintext docs with exactly the qe _ids (+ same 4 indexes). Writes out/m2-stop.json
import fs from 'fs';
import { MongoClient } from 'mongodb';
import { URI } from './lib.mjs';
const c = new MongoClient(URI); await c.connect(); const db = c.db('mongo2');
const ids = (await db.collection('qe').find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).toArray()).map(d => d._id);
let prefix = 0; while (prefix < ids.length && ids[prefix] === prefix + 1) prefix++;
const out = { at: new Date().toISOString(), N: ids.length, maxId: ids.at(-1), contiguousPrefix: prefix, contiguous: prefix === ids.length, gapsAfterPrefix: ids.slice(prefix, prefix + 5) };
await db.collection('plain_n').drop().catch(() => {});
const docs = await db.collection('plain').find({ _id: { $in: ids } }).sort({ _id: 1 }).toArray();
for (let i = 0; i < docs.length; i += 5000) await db.collection('plain_n').insertMany(docs.slice(i, i + 5000));
for (const f of ['company', 'phone', 'name', 'email']) await db.collection('plain_n').createIndex({ [f]: 1 });
out.plainN = await db.collection('plain_n').countDocuments();
console.log(JSON.stringify(out)); fs.writeFileSync('out/m2-stop.json', JSON.stringify(out, null, 1)); await c.close();
