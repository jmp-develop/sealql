/** Disposable benchmark: separate per-field GIN indexes versus one multicolumn GIN. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { compileSearch, type SearchNode } from '../../src/core/search-predicate.js';
import { normalizeText, profiles } from '../../src/core/search-tokens.js';
import { candidateStatement } from '../../src/adapters/postgres/search-sql.js';
import { bindSealed, definePostgresStorage } from '../../src/adapters/postgres/sealed-index.js';
import { binding, executor, fields, guard, pool, query, schema, scopeId, sealer, setEvents, source, type Event } from './common.js';

type Field = typeof fields[number];
type Leaf = { op: 'eq' | 'contains'; field: Field; value: string };
type Node = Leaf | { all: Node[] } | { any: Node[] };
const L = (op: Leaf['op'], field: Field, value: string): Leaf => ({ op, field, value });
const cases: { name: string; node: Node }[] = [
  { name: 'and2', node: { all: [L('eq','company','서울서비스 담당'), L('contains','memo','서비스')] } },
  { name: 'and4', node: { all: [L('eq','company','서울서비스 담당'), L('contains','address','서울'), L('contains','memo','상담'), L('contains','email','service')] } },
  { name: 'and6', node: { all: [L('contains','name','민서'), L('contains','phone','-5'), L('contains','address','서울'), L('contains','memo','서비스'), L('contains','email','test'), L('eq','company','서울서비스 담당')] } },
  { name: 'or2', node: { any: [L('eq','company','서울서비스 담당'), L('contains','memo','푸른달')] } },
  { name: 'or3', node: { any: [L('eq','phone','42-5748-1542'), L('eq','phone','21-7100-5875'), L('contains','name','pshxt')] } },
  { name: 'common', node: L('contains','company','서비') },
  { name: 'medium', node: L('contains','address','세종대로 25') },
  { name: 'rare', node: L('contains','memo','푸른달') },
  { name: 'zero', node: L('contains','memo','없는표식') },
  { name: 'sejong', node: L('contains','address','세종대로') },
  { name: 'daero6', node: L('contains','address','대로6고') },
];
const out = 'bench/results/2026-09-27-multicolumn-gin';
const select = Object.fromEntries(fields.map(f => [f, true]));
const budgets = { maxCandidates: 20000, fetchBytes: 32*1024*1024, decryptedBytes: 32*1024*1024, resultBytes: 32*1024*1024, deadlineMs: 30000 };
const q = (x: string) => `"${x.replaceAll('"','""')}"`;
const full = (x: string) => `${q(schema)}.${q(x)}`;
const median = (a: number[]) => [...a].sort((x,y)=>x-y)[a.length>>1];
const tag = (skip: boolean) => skip ? 'skip' : 'next';
const tableName = (skip: boolean, layout: 'separate'|'multi') => `customers${skip?'_skip':''}_${layout}_mg_index`;
const tokenCols = (b: ReturnType<typeof binding>, mode: 'exact'|'substring') => [...new Set(Object.values(b.storage.index!.profiles!).filter(p=>p.mode===mode).map(p=>p.tokens))];
function same(actual: any[], expected: any[], label: string) {
  assert.equal(actual.length, expected.length, `${label} count`);
  for (let i=0;i<actual.length;i++) {
    assert.equal(actual[i].id, expected[i].id, `${label} id ${i}`);
    for (const f of fields) assert.equal(actual[i][f], expected[i][f], `${label} ${f} ${i}`);
  }
}
function match(n: Node, f: any): any {
  if ('all' in n) return f.all(...n.all.map(x=>match(x,f)));
  if ('any' in n) return f.any(...n.any.map(x=>match(x,f)));
  return f[n.field][n.op](n.value);
}
function compiled(n: Node): SearchNode {
  if ('all' in n) return {op:'all',children:n.all.map(compiled)};
  if ('any' in n) return {op:'any',children:n.any.map(compiled)};
  return n;
}
function plainWhere(n: Node, args: unknown[]): string {
  if ('all' in n) return `(${n.all.map(x=>plainWhere(x,args)).join(' and ')})`;
  if ('any' in n) return `(${n.any.map(x=>plainWhere(x,args)).join(' or ')})`;
  const v=normalizeText(n.value,'legacy-text-v1'); assert(!/[%_\\]/.test(v));
  args.push(v); const p=`$${args.length}`;
  return n.op==='eq' ? `${n.field}_norm=${p}` : `${n.field}_norm like '%'||${p}||'%'`;
}
let opens=0;
const originalOpen=sealer.open.bind(sealer);
sealer.open=async (...args)=>{opens++;return originalOpen(...args)};
async function measure(fn:()=>Promise<any[]>) {
  const events:Event[]=[];setEvents(events);opens=0;const t=performance.now();
  try { const rows=await fn();return {rows,totalMs:performance.now()-t,sqlMs:events.reduce((a,e)=>a+e.sqlMs,0),sqlCalls:events.length,candidates:events.filter(e=>/_mg_index/i.test(e.text)).reduce((a,e)=>a+e.rows,0),authenticatedFields:opens,returned:rows.length}; }
  finally {setEvents(null)}
}
async function makeFixture(skip:boolean,layout:'separate'|'multi') {
  const b=binding('customers',skip), name=tableName(skip,layout), target=full(name), sourceTable=full(b.storage.index!.name);
  const sub=tokenCols(b,'substring'), exact=tokenCols(b,'exact');
  if (!(await pool.query('select to_regclass($1) rel',[`${schema}.${name}`])).rows[0].rel) {
    await pool.query(`create table ${target} as select * from ${sourceTable}`);
    await pool.query(`alter table ${target} add primary key (scope_id,row_id)`);
    for(const col of exact) await pool.query(`create index ${q(`${name}_${col}_bt`)} on ${target} ((${q(col)}[1]))`);
    if(layout==='separate') for(const col of sub) await pool.query(`create index ${q(`${name}_${col}_gin`)} on ${target} using gin (${q(col)})`);
    else await pool.query(`create index ${q(`${name}_gin`)} on ${target} using gin (${sub.map(q).join(',')})`);
    await pool.query(`analyze ${target}`);
  }
  const count=Number((await pool.query(`select count(*) n from ${target}`)).rows[0].n); assert.equal(count,100000);
  const cols=(await pool.query(`select column_name from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position`,[schema,name])).rows.map(r=>r.column_name);
  const sourceCols=(await pool.query(`select column_name from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position`,[schema,b.storage.index!.name])).rows.map(r=>r.column_name);
  assert.deepEqual(cols,sourceCols);
  const size=Number((await pool.query('select pg_total_relation_size(to_regclass($1)) n',[`${schema}.${name}`])).rows[0].n);
  const indexes=(await pool.query(`select indexname,pg_relation_size((quote_ident(schemaname)||'.'||quote_ident(indexname))::regclass) bytes,indexdef from pg_indexes where schemaname=$1 and tablename=$2 order by indexname`,[schema,name])).rows;
  return {variant:tag(skip),layout,name,count,size,indexes,substringColumns:sub,exactColumns:exact};
}
async function readCases(sweep:{term:string;hits:number;target:number}[]) {
  const all=[...cases,...sweep.map((s,i)=>({name:`sweep${i+1}`,node:L('contains','address',s.term)}))];
  const matrix:any[]=[];const explains:any[]=[];
  for(const c of all) {
    const args:unknown[]=[scopeId], where=plainWhere(c.node,args);
    const plain=()=>query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from ${source}.customers where scope_id=$1 and ${where} order by id limit 20`,args).then(r=>r.rows);
    const expected=await plain(), paths:Record<string,()=>Promise<any[]>>={plain};
    for(const skip of [false,true]) for(const layout of ['separate','multi'] as const) {
      const b=binding('customers',skip), name=tableName(skip,layout);
      const stored=Object.entries(b.model.fields).flatMap(([f,s])=>profiles(b.model.id,f,s));
      const search=await compileSearch(compiled(c.node),b.definition,stored,sealer.ring(b.model.id),scopeId);
      const storage={...b.storage,index:{...b.storage.index!,name}};
      const original=b.repo.repository.binding.rows.candidates;
      b.repo.repository.binding.rows.candidates=(exec,params)=>original(exec,{...params,candidateSql:candidateStatement(b.definition,storage,scopeId,search,params.limit<=200?{limit:params.limit,after:params.after?.id}:undefined)});
      const label=`${tag(skip)}_${layout}`;
      paths[label]=async()=>(await b.repo.findMany({match:f=>match(c.node,f),select,limit:20,budgets})).items;
      if (['and2','and4','and6','or2','or3','sejong','daero6'].includes(c.name)) {
        const stmt=candidateStatement(b.definition,storage,scopeId,search);
        const sql=`select id from ${full(`customers${skip?'_skip':''}`)} where scope_id=$1 and ${stmt.text} order by id limit 27`;
        explains.push({case:c.name,variant:tag(skip),layout,statement:stmt,plan:(await pool.query(`explain (analyze,buffers,format json) ${sql}`,stmt.values)).rows[0]['QUERY PLAN'][0]});
      }
    }
    for(const [label,fn] of Object.entries(paths)) same(await fn(),expected,`${c.name}/${label}/initial`);
    for(let i=0;i<2;i++)for(const fn of Object.values(paths))await fn();
    const runs:Record<string,any[]> = Object.fromEntries(Object.keys(paths).map(k=>[k,[]]));
    for(let i=0;i<7;i++) {
      const labels=Object.keys(paths);if(i%2)labels.reverse();
      for(const label of labels){const m=await measure(paths[label]);same(m.rows,expected,`${c.name}/${label}/${i}`);runs[label].push({...m,rows:undefined});}
    }
    const summary=Object.fromEntries(Object.entries(runs).map(([k,v])=>[k,Object.fromEntries(['totalMs','sqlMs','sqlCalls','candidates','authenticatedFields','returned'].map(x=>[x,median(v.map(y=>y[x]))]))]));
    matrix.push({case:c.name,term:'value' in c.node?c.node.value:undefined,rows:expected.length,summary,runs});
    console.log(JSON.stringify({case:c.name,summary}));
    await writeFile(`${out}/matrix.json`,JSON.stringify(matrix,null,2)+'\n');
    await writeFile(`${out}/explain.json`,JSON.stringify(explains,null,2)+'\n');
  }
}
async function chooseSweep(){
  const counts=new Map<string,number>();
  const rows=(await pool.query(`select address_plain from ${source}.customers where scope_id=$1`,[scopeId])).rows;assert.equal(rows.length,100000);
  for(const row of rows){const chars=Array.from(normalizeText(row.address_plain,'legacy-text-v1').replace(/\s+/g,'')),pieces=new Set<string>();
    for(const width of [2,3,4])for(let i=0;i+width<=chars.length;i++)pieces.add(chars.slice(i,i+width).join(''));
    for(const p of pieces)counts.set(p,(counts.get(p)??0)+1);
  }
  const chosen=[];
  for(const target of [10,100,500,1000,2000,5000,10000,20000]){
    const options=[...counts].filter(([term,n])=>n>=Math.max(1,target/2)&&n<=target*2&&!/^\d+$/.test(term)&&!/[%_\\]/.test(term));
    options.sort((a,b)=>Math.abs(Math.log(a[1]/target))-Math.abs(Math.log(b[1]/target))||a[0].localeCompare(b[0]));assert(options.length);
    chosen.push({target,term:options[0][0],hits:options[0][1]});
  }
  chosen.push({target:16574,term:'세종대로',hits:counts.get('세종대로')??0});
  for(const x of chosen)x.hits=Number((await pool.query(`select count(*) n from ${source}.customers where scope_id=$1 and address_norm like '%'||$2||'%'`,[scopeId,x.term])).rows[0].n);
  return chosen;
}
async function writeProbe(skip:boolean,layout:'separate'|'multi', sourceRows:any[], order:number) {
  const name=`mg_write_${tag(skip)}_${layout}`, b0=binding('customers',skip);
  const mapping=definePostgresStorage(b0.model,{schema,table:name,identity:{scope:'scope_id',row:'id',revision:'revision'},fields:Object.fromEntries(fields.map(f=>[f,`${f}_ct`])),indexTable:`${name}_seal_index`});
  if (!(await pool.query('select to_regclass($1) rel',[`${schema}.${name}`])).rows[0].rel)for(const stmt of mapping.ddl)await pool.query(stmt.text,stmt.values);
  const idx=full(`${name}_seal_index`), subs=tokenCols({storage:mapping.storage} as any,'substring');
  if(layout==='multi'){
    const indexes=(await pool.query(`select indexname,indexdef from pg_indexes where schemaname=$1 and tablename=$2`,[schema,`${name}_seal_index`])).rows;
    if(!indexes.some(row=>row.indexname===`${name}_multi_gin`)){
      for(const row of indexes)if(row.indexdef.includes('USING gin'))await pool.query(`drop index ${full(row.indexname)}`);
      await pool.query(`create index ${q(`${name}_multi_gin`)} on ${idx} using gin (${subs.map(q).join(',')})`);
    }
  }
  const repo=bindSealed({sealer,definition:mapping.definition,storage:mapping.storage,executor:executor()}).forScope({scopeId});
  const residual=(await pool.query(`select id,revision from ${full(name)} where scope_id=$1`,[scopeId])).rows;
  for(const r of residual)await repo.delete({id:r.id,expectedRevision:BigInt(r.revision)});
  const times:{insert:number[];update:number[];delete:number[]}={insert:[],update:[],delete:[]};
  const rows=order%2?[...sourceRows].reverse():sourceRows;
  for(const row of rows){const data=Object.fromEntries(fields.map(f=>[f,row[`${f}_plain`]]));const t=performance.now();await repo.insert({id:row.id,data});times.insert.push(performance.now()-t)}
  for(const row of rows){const t=performance.now();await repo.update({id:row.id,expectedRevision:1n,patch:{memo:'다중컬럼 실험 수정값'}});times.update.push(performance.now()-t)}
  const found=await repo.findMany({match:f=>f.memo.eq('다중컬럼 실험 수정값'),select:{memo:true},limit:20,budgets:{maxCandidates:2000}});assert.equal(found.items.length,20);
  for(const row of rows){const t=performance.now();await repo.delete({id:row.id,expectedRevision:2n});times.delete.push(performance.now()-t)}
  assert.equal(Number((await pool.query(`select count(*) n from ${full(name)} where scope_id=$1`,[scopeId])).rows[0].n),0);
  return {variant:tag(skip),layout,order,samples:1000,medianMs:Object.fromEntries(Object.entries(times).map(([k,v])=>[k,median(v)])),totalMs:Object.fromEntries(Object.entries(times).map(([k,v])=>[k,v.reduce((a,b)=>a+b,0)])),times};
}
async function rebuildProbe(skip:boolean,layout:'separate'|'multi') {
  const b=binding('customers',skip),name=tableName(skip,layout), col='future_field_tokens', target=full(name), indexName=`${name}_future_gin`;
  const sub=tokenCols(b,'substring');
  // A nullable token column models adding a searchable field without fabricating new data.
  await pool.query(`alter table ${target} add column if not exists ${q(col)} bigint[]`);
  const t=performance.now();
  if(layout==='separate') await pool.query(`create index ${q(indexName)} on ${target} using gin (${q(col)})`);
  else await pool.query(`create index ${q(indexName)} on ${target} using gin (${[...sub,col].map(q).join(',')})`);
  const ms=performance.now()-t;
  await pool.query(`drop index ${full(indexName)}`);
  await pool.query(`alter table ${target} drop column ${q(col)}`);
  return {variant:tag(skip),layout,ms,method:layout==='separate'?'new field GIN build':'replacement multicolumn GIN build including new field',existingIndexPreserved:true};
}
try{
  await guard();await mkdir(out,{recursive:true});
  const storage=[];for(const skip of [false,true])for(const layout of ['separate','multi'] as const)storage.push(await makeFixture(skip,layout));
  await writeFile(`${out}/storage.json`,JSON.stringify(storage,null,2)+'\n');
  const sweep=await chooseSweep();await writeFile(`${out}/sweep-terms.json`,JSON.stringify(sweep,null,2)+'\n');
  await readCases(sweep);
  const sourceRows=(await pool.query(`select id,${fields.map(f=>`${f}_plain`).join(',')} from ${source}.customers where scope_id=$1 order by id limit 1000`,[scopeId])).rows;assert.equal(sourceRows.length,1000);
  const writes=[];for(const [i,[skip,layout]] of ([ [false,'separate'],[false,'multi'],[true,'multi'],[true,'separate'] ] as const).entries()){writes.push(await writeProbe(skip,layout,sourceRows,i));await writeFile(`${out}/write.json`,JSON.stringify(writes,null,2)+'\n')}
  const rebuild=[];for(const skip of [false,true])for(const layout of ['separate','multi'] as const){rebuild.push(await rebuildProbe(skip,layout));await writeFile(`${out}/rebuild.json`,JSON.stringify(rebuild,null,2)+'\n')}
}finally{await pool.end()}
