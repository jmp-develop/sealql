import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { normalizeText, normalizeWords } from 'sealql';
import { assertDisposable } from '../../test/disposable.js';
import { customersSeal, fields, sealed, scopeId } from './schema.js';

type Field = typeof fields[number];
type Leaf = { op: 'eq' | 'contains' | 'startsWith' | 'endsWith'; field: Field; value: string };
type Node = Leaf | { all: Node[] } | { any: Node[] };
const L = (op: Leaf['op'], field: Field, value: string): Leaf => ({ op, field, value });
const cases: { name: string; node: Node; limit?: number; drain?: boolean; respectWords?: boolean }[] = [
  { name:'exact_common', node:L('eq','company','서울서비스 담당') },
  { name:'exact_mid', node:L('eq','company','서울서비스 중앙지사') },
  { name:'exact_one', node:L('eq','phone','42-5748-1542') },
  { name:'exact_zero', node:L('eq','phone','99-0000-0000') },
  { name:'sub2_common', node:L('contains','company','서비') },
  { name:'sub_mid', node:L('contains','address','세종대로') },
  { name:'sub_mid_space', node:L('contains','address','세종대로 25') },
  { name:'sub_rare', node:L('contains','memo','푸른달') },
  { name:'sub_long', node:L('contains','memo','상세 안내와 확인 내용 상세 안내와') },
  { name:'sub_name_suffix', node:L('contains','name','pshxt') },
  { name:'sub_zero', node:L('contains','memo','없는표식') },
  { name:'starts', node:L('startsWith','address','서울') },
  { name:'ends', node:L('endsWith','email','biz.test') },
  { name:'and2', node:{ all:[L('eq','company','서울서비스 담당'),L('contains','memo','서비스')] } },
  { name:'and4', node:{ all:[L('eq','company','서울서비스 담당'),L('contains','address','서울'),L('contains','memo','상담'),L('contains','email','service')] } },
  { name:'and6', node:{ all:[L('contains','name','민서'),L('contains','phone','-5'),L('contains','address','서울'),L('contains','memo','서비스'),L('contains','email','test'),L('eq','company','서울서비스 담당')] } },
  { name:'or2', node:{ any:[L('eq','company','서울서비스 담당'),L('contains','memo','푸른달')] } },
  { name:'or3', node:{ any:[L('eq','phone','42-5748-1542'),L('eq','phone','21-7100-5875'),L('contains','name','pshxt')] } },
  { name:'drain101', node:L('contains','memo','푸른달'), limit:200, drain:true },
  { name:'word_boundary', node:L('contains','memo','서비스 상담'), respectWords:true },
  { name:'word_inside_longer', node:L('contains','memo','비스 상'), respectWords:true },
];
const mode=process.argv[2];
assert(mode===undefined||mode==='before-vacuum'||mode==='after-vacuum');
const followup=new Set(['sub_name_suffix','or3','and6','sub_mid_space','sub_long','exact_common','sub_mid','starts']);
const selected=mode?cases.filter(c=>followup.has(c.name)):cases;
assert.equal(selected.length,mode?8:21);
const pool = new Pool({ host:'127.0.0.1', port:56439, user:'sealql_test', database:'postgres', max:4,
  options:'-c statement_timeout=120000' });
const db = drizzle(pool);
type Event = { sqlMs: number; rows: number; text: string };
let events: Event[] | null = null;
const original = Client.prototype.query;
(Client.prototype as any).query = function (...args: any[]) {
  const started = performance.now(), text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
  const end = (result: any) => { events?.push({ sqlMs:performance.now()-started, rows:result?.rows?.length ?? 0, text }); return result; };
  const callback = args.findIndex(x => typeof x === 'function');
  if (callback >= 0) { const cb = args[callback]; args[callback] = (err: any, result: any) => { if (!err) end(result); cb(err, result); }; }
  const result = (original as any).apply(this, args);
  return callback < 0 && result?.then ? result.then(end) : result;
};
const norm = (v: string) => normalizeText(v, 'legacy-text-v1');
function plainWhere(n: Node, p: unknown[]): string {
  if ('all' in n) return `(${n.all.map(x => plainWhere(x,p)).join(' and ')})`;
  if ('any' in n) return `(${n.any.map(x => plainWhere(x,p)).join(' or ')})`;
  const v=norm(n.value); assert(!/[%_\\]/.test(v)); p.push(v); const ph=`$${p.length}`;
  return n.op==='eq' ? `${n.field}_norm=${ph}` : n.op==='contains' ? `${n.field}_norm like '%'||${ph}||'%'`
    : n.op==='startsWith' ? `${n.field}_norm like ${ph}||'%'` : `${n.field}_norm like '%'||${ph}`;
}
async function plain(c: typeof cases[number]) {
  const out: any[]=[]; let after: string | undefined; const limit=c.limit??20;
  do {
    const p: unknown[]=[scopeId], where=plainWhere(c.node,p);
    if (after) p.push(after);
    const rows=(await pool.query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers
      where scope_id=$1 and ${where}${after?` and id>$${p.length}`:''} order by id ${c.respectWords?'':`limit ${limit}`}`,p)).rows;
    if (c.respectWords) return rows.filter(r=>normalizeWords(r.memo).includes(normalizeWords((c.node as Leaf).value))).slice(0,limit);
    out.push(...rows); if (!c.drain || rows.length<limit) break; after=rows.at(-1).id;
  } while (true);
  return out;
}
function match(n: Node, m: any, respectWords=false): any {
  if ('all' in n) return m.and(...n.all.map(x=>match(x,m,respectWords)));
  if ('any' in n) return m.or(...n.any.map(x=>match(x,m,respectWords)));
  return n.op==='contains' && respectWords ? m[n.field].contains(n.value,{respectWords:true}) : m[n.field][n.op](n.value);
}
async function product(c: typeof cases[number]) {
  const out: any[]=[]; let cursor: string | undefined; const limit=c.limit??20;
  do {
    const page=await sealed.findMany(db, customersSeal, { scope:scopeId, match:m=>match(c.node,m,c.respectWords),
      columns:Object.fromEntries(fields.map(f=>[f,true])) as any, limit, cursor,
      budgets:{ maxCandidates:20000, fetchBytes:32*1024*1024, decryptedBytes:32*1024*1024,
        resultBytes:32*1024*1024, deadlineMs:30000 } });
    out.push(...page.items); if (!c.drain || !page.nextCursor) break; cursor=page.nextCursor;
  } while (true);
  return out;
}
function same(actual: any[], expected: any[], label: string) {
  assert.equal(actual.length,expected.length,`${label}/count`);
  for(let i=0;i<actual.length;i++) {
    assert.equal(actual[i].id,expected[i].id,`${label}/id/${i}`);
    for(const f of fields) assert.equal(actual[i][f],expected[i][f],`${label}/${f}/${i}`);
  }
}
async function measure(fn:()=>Promise<any[]>) {
  const ev:Event[]=[]; events=ev; const started=performance.now();
  try { const rows=await fn(); return { rows, totalMs:performance.now()-started, sqlMs:ev.reduce((s,x)=>s+x.sqlMs,0),
    sqlCalls:ev.length, candidates:ev.reduce((s,x)=>s+x.rows,0), returned:rows.length,
    sql:ev.map(x=>x.text) }; } finally { events=null; }
}
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[a.length>>1];
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  for(const table of ['customers','tickets']) assert.equal(Number((await pool.query(`select count(*) n from native_verify_main.${table}`)).rows[0].n),100000);
  const outDir='bench/results/2026-09-27-native-verification/v3'; await mkdir(outDir,{recursive:true});
  const report=[];
  for(const c of selected) {
    const expected=await plain(c); same(await product(c),expected,`${c.name}/first`);
    for(let i=0;i<2;i++) { same(await plain(c),expected,`${c.name}/warmup/plain`); same(await product(c),expected,`${c.name}/warmup/product`); }
    const runs:{plain:any[];product:any[]}={plain:[],product:[]};
    for(let i=0;i<7;i++) for(const path of (i%2?['product','plain']:['plain','product']) as ('plain'|'product')[]) {
      const result=await measure(path==='plain'?()=>plain(c):()=>product(c)); same(result.rows,expected,`${c.name}/${path}/${i}`);
      runs[path].push({ ...result, rows:undefined });
    }
    const metrics=['totalMs','sqlMs','sqlCalls','candidates','returned'] as const;
    const summary=Object.fromEntries(Object.entries(runs).map(([path,rs])=>[path,Object.fromEntries(metrics.map(k=>[k,median(rs.map(r=>r[k]))]))]));
    report.push({case:c.name,expected:expected.length,summary,runs});
    console.log(JSON.stringify({case:c.name,summary}));
    await writeFile(`${outDir}/${mode?`matrix-${mode}`:'matrix'}.json`,JSON.stringify({schema:'native_verify_main',mode:mode??'baseline',warmup:2,alternatingRuns:7,report},null,2)+'\n');
  }
} finally { Client.prototype.query=original; await pool.end(); }
