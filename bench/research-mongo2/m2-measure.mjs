// Usage: node m2-measure.mjs <warm> <runs> ; writes out/m2-measure.json
import fs from 'fs';
import { connect } from './lib.mjs';
import { getKeys2, encEq2, encSub2 } from './m2-lib.mjs';
let [WARM, RUNS] = process.argv.slice(2).map(Number);
const LOCK = 'D:/Projects/Private/sealql/.local/research/measure.lock', OUT = process.env.OUT ?? 'out/m2-measure.json', TAG = process.env.LOCK_TAG ?? 'm2-fable mongo2', LOCK_WAIT = Number(process.env.LOCK_WAIT_MS ?? 360000);
const N = process.env.N ? Number(process.env.N) : JSON.parse(fs.readFileSync('out/m2-load.json', 'utf8')).N;
const { plain, enc, ce } = await connect(); const keys = await getKeys2(ce, plain);
const P = plain.db('mongo2').collection(process.env.PLAIN_COLL ?? 'plain'), Q = enc.db('mongo2').collection('qe');
const X = '서울서비스담당'; // query values use the stored normalization (spaces removed), as the PostgreSQL product does
const eq = (f, v) => ['eq', f, v], has = (f, v) => ['sub', f, v], and = (...a) => ['and', ...a], or = (...a) => ['or', ...a];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pf = n => n[0] === 'eq' ? { [n[1]]: n[2] } : n[0] === 'sub' ? { [n[1]]: { $regex: esc(n[2]) } } : { ['$' + n[0]]: n.slice(1).map(pf) };
const qf = async n => n[0] === 'eq' ? { [n[1]]: await encEq2(ce, keys, n[1], n[2]) } : n[0] === 'sub' ? { $expr: { $encStrContains: { input: '$' + n[1], substring: await encSub2(ce, keys, n[1], n[2]) } } } : { ['$' + n[0]]: await Promise.all(n.slice(1).map(qf)) };
const txt = n => n[0] === 'eq' ? `${n[1]} = "${n[2]}"` : n[0] === 'sub' ? `${n[1]} ∋ "${n[2]}"` : '(' + n.slice(1).map(txt).join(n[0] === 'and' ? ' AND ' : ' OR ') + ')';
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
const out = { at: new Date().toISOString(), N, warm: WARM, runs: RUNS, cases: [] };
// correctness + support check first (untimed)
const live = [];
for (const [name, node] of CASES) {
  const c = { name, cond: txt(node) };
  const pfl = N >= 100000 || process.env.PLAIN_COLL ? pf(node) : { $and: [{ _id: { $lte: N } }, pf(node)] }; // at N = 100,000 the plaintext baseline is the whole collection, no _id filter
  c.plainCount = await P.countDocuments(pfl);
  try {
    const qfl = await qf(node);
    c.qeCount = await Q.countDocuments(qfl);
    const pl = (await P.find(pfl, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(300).toArray()).map(d => d._id);
    const ql = await Q.find(qfl).sort({ _id: 1 }).limit(300).toArray();
    c.listLen = ql.length; c.listEqual = JSON.stringify(pl) === JSON.stringify(ql.map(d => d._id));
    c.countEqual = c.plainCount === c.qeCount; c.supported = true; live.push([c, pfl, node]);
  } catch (e) { c.supported = false; c.error = e.message; }
  console.log(JSON.stringify(c)); out.cases.push(c);
}
// explain + storage (untimed, before the timing lock)
const tags = (o, acc = []) => { if (Array.isArray(o)) o.forEach(x => tags(x, acc)); else if (o && typeof o === 'object' && !o._bsontype) for (const [k, v] of Object.entries(o)) { if (k === '__safeContent__') { const inn = v?.$elemMatch?.$in ?? v?.$in; acc.push(Array.isArray(inn) ? inn.length : null); } else tags(v, acc); } return acc; };
out.explain = {};
for (const [name, node] of [['company', eq('company', X)], ['memo_서비스', has('memo', '서비스')], ['and2', CASES.find(c => c[0] === 'and2')[1]], ['or2', CASES.find(c => c[0] === 'or2')[1]]]) {
  try { const e = await enc.db('mongo2').command({ explain: { count: 'qe', query: await qf(node) }, verbosity: 'executionStats' });
  const es = e.executionStats; out.explain[name] = { tags: tags(e.queryPlanner ?? e), keysExamined: es.totalKeysExamined, docsExamined: es.totalDocsExamined, executionTimeMillis: es.executionTimeMillis };
  console.log('explain', name, JSON.stringify(out.explain[name])); } catch (err) { out.explain[name] = { error: err.message }; console.log('explain failed', name, err.message); }
}
out.storage = {};
for (const coll of ['plain', 'qe', 'enxcol_.qe.esc', 'enxcol_.qe.ecoc']) {
  const [s] = await plain.db('mongo2').collection(coll).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
  const st = s.storageStats; out.storage[coll] = { count: st.count, size: st.size, storageSize: st.storageSize, totalIndexSize: st.totalIndexSize };
}
console.log(JSON.stringify(out.storage));
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
if (process.env.SMOKE) process.exit(0);
// lock
const sleep = ms => new Promise(r => setTimeout(r, ms)); const tw = Date.now();
for (;;) { try { fs.writeFileSync(LOCK, `${TAG} ${new Date().toISOString()}`, { flag: 'wx' }); break; } catch { if (Date.now() - tw > LOCK_WAIT) throw new Error('lock wait > ' + LOCK_WAIT + ' ms'); console.log('lock busy:', fs.readFileSync(LOCK, 'utf8')); await sleep(15000); } }
out.lockAcquired = new Date().toISOString(); if (process.env.FALLBACK_AFTER && Date.now() > Date.parse(process.env.FALLBACK_AFTER)) { WARM = 1; RUNS = 3; out.fallback = 'lock acquired after ' + process.env.FALLBACK_AFTER + ': warm 1 + 3 runs'; } out.warm = WARM; out.runs = RUNS; out.lockWaitMs = Date.now() - tw;
try {
  for (const [c, pfl, node] of live) {
    const t = { pc: [], qc: [], pl: [], ql: [] };
    const time = async (arr, fn, keep) => { const s = performance.now(); await fn(); if (keep) arr.push(performance.now() - s); };
    for (let r = 0; r < WARM + RUNS; r++) {
      const keep = r >= WARM, order = r % 2 === 0;
      const P1 = () => time(t.pc, () => P.countDocuments(pfl), keep), Q1 = () => time(t.qc, async () => Q.countDocuments(await qf(node)), keep);
      const P2 = () => time(t.pl, () => P.find(pfl).sort({ _id: 1 }).limit(300).toArray(), keep), Q2 = () => time(t.ql, async () => Q.find(await qf(node)).sort({ _id: 1 }).limit(300).toArray(), keep);
      if (order) { await P1(); await Q1(); await P2(); await Q2(); } else { await Q1(); await P1(); await Q2(); await P2(); }
    }
    Object.assign(c, { plainCountMs: med(t.pc), qeCountMs: med(t.qc), plainListMs: med(t.pl), qeListMs: med(t.ql), raw: t });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); console.log(c.name, c.plainCountMs.toFixed(1), c.qeCountMs.toFixed(1), c.plainListMs.toFixed(1), c.qeListMs.toFixed(1));
  }
} finally {
  if (fs.existsSync(LOCK) && fs.readFileSync(LOCK, 'utf8').startsWith(TAG)) fs.unlinkSync(LOCK);
  out.lockReleased = new Date().toISOString();
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
await plain.close(); await enc.close();
