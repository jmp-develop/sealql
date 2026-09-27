import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { normalizeText, normalizeWords } from 'sealql';
import { assertDisposable } from '../../test/disposable.js';
import { fields, scopeId as scopeA } from './schema.js';
import { scaleCustomersSeal, scaleSealed } from './scale-schema.js';
const scopeB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
const selected=cases;
assert.equal(selected.length,21);
const pool = new Pool({ host:'127.0.0.1', port:56439, user:'sealql_test', database:'postgres', max:4,
  options:'-c statement_timeout=300000' });
const db = drizzle(pool);
type Event = { started: number; ended: number; sqlMs: number; rows: number; text: string };
let events: Event[] | null = null;
const original = Client.prototype.query;
(Client.prototype as any).query = function (...args: any[]) {
  const started = performance.now(), text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
  const end = (result: any) => { const ended=performance.now();events?.push({started,ended,
    sqlMs:ended-started,rows:result?.rows?.length ?? 0,text});return result; };
  const callback = args.findIndex(x => typeof x === 'function');
  if (callback >= 0) { const cb = args[callback]; args[callback] = (err: any, result: any) => { end(result); cb(err, result); }; }
  const result = (original as any).apply(this, args);
  return callback < 0 && result?.then ? result.then(end,(err:any)=>{end(null);throw err;}) : result;
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
  const out: any[]=[]; let after: string | undefined; const limit=20;
  const started=performance.now();let pages=0;
  do {
    const p: unknown[]=[scopeB], where=plainWhere(c.node,p);
    if (after) p.push(after);
    const queryLimit=c.respectWords?1000:limit;
    const rows=(await pool.query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from native_scale_100m.customers_plain
      where scope_id=$1 and ${where}${after?` and id>$${p.length}`:''} order by id limit ${queryLimit}`,p)).rows;
    pages++;
    if(c.respectWords){
      out.push(...rows.filter(r=>normalizeWords(r.memo).includes(normalizeWords((c.node as Leaf).value))));
      if(out.length>=limit||rows.length<queryLimit)return out.slice(0,limit);
      after=rows.at(-1).id;continue;
    }
    out.push(...rows); if (rows.length<limit || pages>=1 || performance.now()-started>=300000) break;
    after=rows.at(-1).id;
  } while (true);
  return out;
}
function match(n: Node, m: any, respectWords=false): any {
  if ('all' in n) return m.and(...n.all.map(x=>match(x,m,respectWords)));
  if ('any' in n) return m.or(...n.any.map(x=>match(x,m,respectWords)));
  return n.op==='contains' && respectWords ? m[n.field].contains(n.value,{respectWords:true}) : m[n.field][n.op](n.value);
}
async function product(c: typeof cases[number]) {
  const out: any[]=[]; let cursor: string | undefined; const limit=20;
  const started=performance.now();let pages=0;
  do {
    const page=await scaleSealed.findMany(db, scaleCustomersSeal, { scope:scopeB, match:m=>match(c.node,m,c.respectWords),
      columns:Object.fromEntries(fields.map(f=>[f,true])) as any, limit, cursor,
      budgets:{ maxCandidates:20000, fetchBytes:32*1024*1024, decryptedBytes:32*1024*1024,
        resultBytes:32*1024*1024, deadlineMs:30000 } });
    out.push(...page.items);pages++;
    if (!page.nextCursor || pages>=1 || performance.now()-started>=300000) break;
    cursor=page.nextCursor;
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
function verify(result:{rows:any[];error?:string},expected:any[],label:string){
  if(result.error){assert(['LIMIT_EXCEEDED','57014'].includes(result.error),`${label}/error/${result.error}`);return;}
  same(result.rows,expected,label);
}
async function measure(fn:()=>Promise<any[]>) {
  const ev:Event[]=[]; events=ev; const started=performance.now();
  let rows:any[]=[],error:string|undefined;
  try{rows=await fn();}catch(e:any){if(!['LIMIT_EXCEEDED','57014'].includes(e?.code))throw e;error=e.code;}
  finally{events=null;}
  const finished=performance.now(),totalMs=finished-started,sqlMs=ev.reduce((s,x)=>s+x.sqlMs,0);
  const preMs=ev.length?ev[0].started-started:totalMs;
  const postMs=ev.length?finished-ev.at(-1)!.ended:0;
  return {rows,error,totalMs,preMs,sqlMs,postMs,betweenSqlMs:Math.max(0,totalMs-preMs-sqlMs-postMs),
    sqlCalls:ev.length,candidates:ev.reduce((s,x)=>s+x.rows,0),returned:rows.length,
    sql:ev.map(x=>x.text),sqlEvents:ev};
}
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[a.length>>1];
async function actualMatches(c:typeof cases[number]){
  const p:unknown[]=[scopeA],where=plainWhere(c.node,p);
  if(!c.respectWords)return Number((await pool.query(`select count(*) n from bench_realistic_100k.customers where scope_id=$1 and ${where}`,p)).rows[0].n);
  const rows=(await pool.query(`select memo_plain from bench_realistic_100k.customers where scope_id=$1 and ${where}`,p)).rows;
  const term=normalizeWords((c.node as Leaf).value);
  return rows.filter(r=>normalizeWords(r.memo_plain).includes(term)).length;
}
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from native_scale_100m.progress')).rows[0].n),1000);
  const outDir='bench/results/2026-09-27-native-scale-100m/scope-b'; await mkdir(outDir,{recursive:true});
  const report:any[]=process.argv[2]==='resume'
    ?JSON.parse(await readFile(`${outDir}/matrix.json`,'utf8')).report:[];
  for(let i=0;i<report.length;i++)assert.equal(report[i].case,selected[i].name);
  for(const c of selected.slice(report.length)) {
    const matches=await actualMatches(c);
    const firstPlain=await measure(()=>plain(c)),expected=firstPlain.rows;
    assert.equal(expected.length,Math.min(matches,20),`${c.name}/actualMatches`);
    const firstProduct=await measure(()=>product(c));verify(firstProduct,expected,`${c.name}/first`);
    const warmupProduct=[];
    for(let i=0;i<2;i++) { same(await plain(c),expected,`${c.name}/warmup/plain`);
      const result=await measure(()=>product(c));verify(result,expected,`${c.name}/warmup/product`);warmupProduct.push(result); }
    const runs:{plain:any[];product:any[]}={plain:[],product:[]};
    for(let i=0;i<7;i++) for(const path of (i%2?['product','plain']:['plain','product']) as ('plain'|'product')[]) {
      const result=await measure(path==='plain'?()=>plain(c):()=>product(c));verify(result,expected,`${c.name}/${path}/${i}`);
      runs[path].push({ ...result, rows:undefined });
    }
    const metrics=['totalMs','preMs','sqlMs','postMs','betweenSqlMs','sqlCalls','candidates','returned'] as const;
    const summary=Object.fromEntries(Object.entries(runs).map(([path,rs])=>[path,Object.fromEntries(metrics.map(k=>[k,median(rs.map(r=>r[k]))]))]));
    const productErrors=Number(!!firstProduct.error)+warmupProduct.filter(x=>x.error).length+runs.product.filter(x=>x.error).length;
    report.push({case:c.name,searchRows:100000000,scopeRows:100000,actualMatches:matches,expected:expected.length,
      plainRule:'warmup2_cross7',productRule:'warmup2_cross7',
      productOutcome:productErrors?'error':'value',
      productErrorRuns:productErrors,first:{plain:{...firstPlain,rows:undefined},
      product:{...firstProduct,rows:undefined}},summary,runs});
    console.log(JSON.stringify({case:c.name,productErrors,summary}));
    await writeFile(`${outDir}/matrix.json`,JSON.stringify({schema:'native_scale_100m',scope:scopeB,copies:1000,warmup:2,alternatingRuns:7,report},null,2)+'\n');
  }
} finally { Client.prototype.query=original; await pool.end(); }
