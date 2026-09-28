import fs from 'fs';
import { MongoClient } from 'mongodb';
import { URI } from './lib.mjs';
const c = new MongoClient(URI); await c.connect();
const [s] = await c.db('mongo2').collection('plain_n').aggregate([{ $collStats: { storageStats: {} } }]).toArray();
const st = s.storageStats, o = { count: st.count, size: st.size, storageSize: st.storageSize, totalIndexSize: st.totalIndexSize };
console.log(JSON.stringify(o)); fs.writeFileSync('out/m2-plainn-storage.json', JSON.stringify(o)); await c.close();
