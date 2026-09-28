// Plaintext-only re-timing on a copy holding exactly the first N docs (mongo2.plain_n), so the plaintext baseline has no `_id <= N` filter.
import fs from 'fs';
import { MongoClient } from 'mongodb';
const LOCK = 'D:/Projects/Private/sealql/.local/research/measure.lock';
const N = JSON.parse(fs.readFileSync('out/m2-load.json', 'utf8')).N, M = JSON.parse(fs.readFileSync('out/m2-measure.json', 'utf8'));
const c = new MongoClient('mongodb://127.0.0.1:27117/?replicaSet=rs0'); await c.connect();
const db = c.db('mongo2');
await db.collection('plain_n').drop().catch(() => {});
await db.collection('plain').aggregate([{ $match: { _id: { $lte: N } } }, { $out: 'plain_n' }]).toArray();
for (const f of ['company', 'phone', 'name', 'email']) await db.collection('plain_n').createIndex({ [f]: 1 });
const P = db.collection('plain_n');
const X = '서울서비스담당'; // query values use the stored normalization (spaces removed), as the PostgreSQL product does
const eq = (f, v) => ['eq', f, v], has = (f, v) => ['sub', f, v], and = (...a) => ['and', ...a], or = (...a) => ['or', ...a];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pf = n => n[0] === 'eq' ? { [n[1]]: n[2] } : n[0] === 'sub' ? { [n[1]]: { $regex: esc(n[2]) } } : { ['$' + n[0]]: n.slice(1).map(pf) };
const CASES = [
  ['eq_company_1', eq('company', X)], ['eq_company_2', eq('company', '서울서비스중앙지사')], ['eq_phone_1', eq('phone', '42-5748-1542')], ['eq_phone_0', eq('phone', '99-0000-0000')],
  ['sub_memo_서비스', has('memo', '서비스')], ['sub_memo_푸른달', has('memo', '푸른달')], ['sub_memo_없는표식', has('memo', '없는표식')], ['sub_memo_상담서비스', has('memo', '상담서비스')],
  ['sub_memo_서비스상담', has('memo', '서비스상담')], ['sub_memo_비스상', has('memo', '비스상')], ['sub_addr_세종대로', has('address', '세종대로')], ['sub_addr_세종대로25', has('address', '세종대로25')],
  ['sub_memo_14', has('memo', '상세안내와확인내용상세안내와')], ['sub_memo_45', has('memo', '상세안내와확인내용'.repeat(5))],
  ['and2', and(eq('company', X), has('memo', '서비스'))], ['or2', or(eq('company', X), has('memo', '푸른달'))],
  ['or_and', or(and(eq('company', X), has('memo', '서비스')), has('memo', '푸른달'))], ['zero_and', and(eq('company', X), has('address', '부산'))],
  ['or4', or(eq('company', X), has('memo', '푸른달'), eq('phone', '42-5748-1542'), has('address', '세종대로'))],
  ['nested', and(or(and(eq('company', X), has('memo', '서비스')), and(has('address', '서울'), has('memo', '상담'))), or(eq('phone', '42-5748-1542'), has('memo', '푸른달')))],
];
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const out = { at: new Date().toISOString(), N, warm: M.warm, runs: M.runs, count: await P.countDocuments(), cases: {} };
const sleep = ms => new Promise(r => setTimeout(r, ms)); const tw = Date.now();
for (;;) { try { fs.writeFileSync(LOCK, `m2-fable mongo2 ${new Date().toISOString()}`, { flag: 'wx' }); break; } catch { if (Date.now() - tw > 150000) { console.log('lock wait > 150 s, skipped'); process.exit(2); } await sleep(5000); } }
out.lockAcquired = new Date().toISOString();
try {
  for (const [name, node] of CASES) {
    const f = pf(node), t = { pc: [], pl: [] }; let cnt;
    for (let r = 0; r < M.warm + M.runs; r++) {
      let s = performance.now(); cnt = await P.countDocuments(f); if (r >= M.warm) t.pc.push(performance.now() - s);
      s = performance.now(); await P.find(f).sort({ _id: 1 }).limit(300).toArray(); if (r >= M.warm) t.pl.push(performance.now() - s);
    }
    out.cases[name] = { count: cnt, countMs: med(t.pc), listMs: med(t.pl), raw: t };
    console.log(name, cnt, med(t.pc).toFixed(2), med(t.pl).toFixed(2));
  }
} finally { if (fs.existsSync(LOCK) && fs.readFileSync(LOCK, 'utf8').startsWith('m2-fable mongo2')) fs.unlinkSync(LOCK); out.lockReleased = new Date().toISOString(); }
fs.writeFileSync('out/m2-plain-n.json', JSON.stringify(out, null, 1));
await c.close();
