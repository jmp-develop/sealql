/** Disposable, benchmark-only comparison of per-field and combined GIN layouts. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { compileSearch, type CompiledSearch, type SearchNode } from '../../src/core/search-predicate.js';
import { profiles, normalizeText, searchPieces, searchTokens } from '../../src/core/search-tokens.js';
import { binding, fields, guard, pool, query, schema, scopeId, sealer, setEvents, source, type Event } from './common.js';

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
const select = Object.fromEntries(fields.map(f => [f, true]));
const budgets = { maxCandidates: 20000, fetchBytes: 32*1024*1024, decryptedBytes: 32*1024*1024, resultBytes: 32*1024*1024, deadlineMs: 30000 };
const median = (xs: number[]) => [...xs].sort((a,b) => a-b)[xs.length >> 1];
const outputDir = 'bench/results/2026-09-27-combined-gin';
const qid = (s: string) => `"${s.replaceAll('"','""')}"`;
const full = (s: string) => `${qid(schema)}.${qid(s)}`;
let opens = 0;
const originalOpen = sealer.open.bind(sealer);
sealer.open = async (...args) => { opens++; return originalOpen(...args); };
function same(actual: any[], expected: any[], label: string) {
  assert.equal(actual.length, expected.length, `${label} count`);
  for (let i=0;i<actual.length;i++) {
    assert.equal(actual[i].id,expected[i].id,`${label} id ${i}`);
    for (const f of fields) assert.equal(actual[i][f],expected[i][f],`${label} ${f} ${i}`);
  }
}
function match(node: Node, f: any): any {
  if ('all' in node) return f.all(...node.all.map(x=>match(x,f)));
  if ('any' in node) return f.any(...node.any.map(x=>match(x,f)));
  return f[node.field][node.op](node.value);
}
function plainWhere(node: Node, values: unknown[]): string {
  if ('all' in node) return `(${node.all.map(x=>plainWhere(x,values)).join(' and ')})`;
  if ('any' in node) return `(${node.any.map(x=>plainWhere(x,values)).join(' or ')})`;
  const value=normalizeText(node.value,'legacy-text-v1'); assert(!/[%_\\]/.test(value));
  values.push(value); const ph=`$${values.length}`;
  return node.op==='eq' ? `${node.field}_norm=${ph}` : `${node.field}_norm like '%'||${ph}||'%'`;
}
function compiledNode(node: Node): SearchNode {
  if ('all' in node) return {op:'all',children:node.all.map(compiledNode)};
  if ('any' in node) return {op:'any',children:node.any.map(compiledNode)};
  return node;
}
function statement(compiled: CompiledSearch, b: ReturnType<typeof binding>, skip: boolean, bounded?: {limit:number;after?:string}) {
  const values: unknown[]=[scopeId];
  const exactCols=new Set<string>();
  const leaf=(n: CompiledSearch, alias: string): string => {
    assert.equal(n.op,'leaf'); const {profile,tokens}=n.leaf;
    const mapped=b.storage.index!.profiles![profile.indexId]; assert(mapped);
    if (mapped.mode==='exact') { exactCols.add(mapped.tokens); values.push(tokens[0]); return `(${qid(alias)}.${qid(mapped.tokens)})[1]=$${values.length}::bigint`; }
    values.push(tokens); return `${qid(alias)}.${qid('combined_tokens')} @> $${values.length}::bigint[]`;
  };
  const expr=(n:CompiledSearch,alias:string):string => {
    if(n.op==='leaf') return leaf(n,alias);
    if(n.op==='any') return `(${n.children.map(x=>expr(x,alias)).join(' or ')})`;
    // One @> asks the single GIN for every substring key in this AND group.
    const substring=n.children.filter(x=>x.op==='leaf'&&x.leaf.profile.mode==='substring');
    const other=n.children.filter(x=>!substring.includes(x));
    const parts:string[]=[];
    if(substring.length){values.push(substring.flatMap(x=>(x as Extract<CompiledSearch,{op:'leaf'}>).leaf.tokens));parts.push(`${qid(alias)}.${qid('combined_tokens')} @> $${values.length}::bigint[]`);}
    parts.push(...other.map(x=>expr(x,alias)));
    return `(${parts.join(' and ')})`;
  };
  const alias='c'; const condition=expr(compiled,alias);
  const table=full(`customers${skip?'_skip':''}_combined_seal_index`);
  const row=`${qid(b.storage.parent.name)}.${qid('id')}`;
  const keyset=bounded?.after ? (values.push(bounded.after),` and ${qid(alias)}.row_id>$${values.length}`) : '';
  let text:string;
  if(bounded){
    const cols=[qid('combined_tokens'),...exactCols].join(',');
    text=`${row} in (with sample as materialized (select row_id,${cols} from ${table} as ${qid(alias)} where ${qid(alias)}.scope_id=$1${keyset} order by ${qid(alias)}.row_id limit 256), quick as materialized (select row_id from sample as ${qid(alias)} where ${condition} order by row_id limit ${bounded.limit}), fallback as materialized (select row_id from ${table} as ${qid(alias)} where ${qid(alias)}.scope_id=$1${keyset} and ${condition} and (select count(*) from quick)<${bounded.limit} order by row_id limit ${bounded.limit}) select row_id from quick where (select count(*) from quick)=${bounded.limit} union all select row_id from fallback)`;
  } else text=`${row} in (select row_id from ${table} as ${qid(alias)} where ${qid(alias)}.scope_id=$1 and ${condition})`;
  return {text,values};
}
async function fixture(skip:boolean) {
  const b=binding('customers',skip), sourceTable=full(b.storage.index!.name), targetName=`customers${skip?'_skip':''}_combined_seal_index`, target=full(targetName);
  const entries=Object.values(b.storage.index!.profiles!); const subs=entries.filter(x=>x.mode==='substring').map(x=>qid(x.tokens));
  const exact=entries.filter(x=>x.mode==='exact').map(x=>qid(x.tokens));
  const exists=(await pool.query('select to_regclass($1) rel',[`${schema}.${targetName}`])).rows[0].rel;
  if(!exists){
    await pool.query(`create table ${target} as select scope_id,row_id,${exact.join(',')},${subs.map(x=>`coalesce(${x},'{}'::bigint[])`).join(' || ')} as combined_tokens from ${sourceTable}`);
    await pool.query(`alter table ${target} add primary key (scope_id,row_id)`);
    await pool.query(`create index ${qid(targetName+'_gin')} on ${target} using gin (combined_tokens)`);
    for(const col of exact) await pool.query(`create index ${qid(targetName+'_'+col.replaceAll('"','')+'_bt')} on ${target} ((${col}[1]))`);
    await pool.query(`analyze ${target}`);
  }
  const originalCount=Number((await pool.query(`select count(*) n from ${sourceTable}`)).rows[0].n);
  const combinedCount=Number((await pool.query(`select count(*) n from ${target}`)).rows[0].n);
  assert.equal(originalCount,100000); assert.equal(combinedCount,originalCount);
  const size=async(t:string)=>Number((await pool.query('select pg_total_relation_size(to_regclass($1)) n',[`${schema}.${t}`])).rows[0].n);
  return {variant:skip?'skip':'next',sourceTable:b.storage.index!.name,targetName,rows:combinedCount,sourceBytes:await size(b.storage.index!.name),combinedBytes:await size(targetName)};
}
async function measure(fn:()=>Promise<any[]>) {
  const events:Event[]=[]; setEvents(events); opens=0; const started=performance.now();
  try {const rows=await fn();return {rows,totalMs:performance.now()-started,sqlMs:events.reduce((s,e)=>s+e.sqlMs,0),sqlCalls:events.length,candidates:events.filter(e=>/ in \(select |with sample|_seal_index/i.test(e.text)).reduce((s,e)=>s+e.rows,0),authenticatedFields:opens,returned:rows.length};}
  finally {setEvents(null);}
}
async function costs(skip:boolean) {
  const b=binding('customers',skip), original=full(b.storage.index!.name), combined=full(`customers${skip?'_skip':''}_combined_seal_index`);
  const entries=Object.entries(b.storage.index!.profiles!);
  const exact=entries.filter(([,v])=>v.mode==='exact').map(([,v])=>qid(v.tokens));
  const subs=entries.filter(([,v])=>v.mode==='substring').map(([id,v])=>({field:id.split('/')[0] as Field,col:qid(v.tokens)}));
  const originalRow=(await pool.query(`select * from ${original} where scope_id=$1 order by row_id limit 1`,[scopeId])).rows[0]; assert(originalRow);
  const rowId=originalRow.row_id; const all=[...subs.flatMap(x=>originalRow[x.col.slice(1,-1)] ?? [])];
  const indexCols=['scope_id','row_id',...exact.map(x=>x.slice(1,-1)),'combined_tokens'];
  const values=[scopeId,rowId,...exact.map(x=>originalRow[x.slice(1,-1)]),all];
  const client=await pool.connect();
  try {
    await client.query('begin');
    // Fresh sentinel row uses existing tokens; rolled back, so no fixture is left changed.
    const sentinel='ffffffff-ffff-4fff-8fff-ffffffffffff';
    const fresh=[scopeId,sentinel,...values.slice(2)];
    const parent=full(`customers${skip?'_skip':''}`);
    const parentCols=['scope_id','id','revision',...fields.map(f=>`${f}_ct`)];
    await client.query(`insert into ${parent} (${parentCols.map(qid).join(',')}) select scope_id,$1,revision,${fields.map(f=>qid(`${f}_ct`)).join(',')} from ${parent} where scope_id=$2 and id=$3`,[sentinel,scopeId,rowId]);
    const originalCols=['scope_id','row_id',...entries.map(([,v])=>v.tokens)];
    const originalValues=[scopeId,sentinel,...entries.map(([,v])=>originalRow[v.tokens])];
    const originalIns=performance.now();await client.query(`insert into ${original} (${originalCols.map(qid).join(',')}) values (${originalValues.map((_,i)=>`$${i+1}`).join(',')})`,originalValues);const originalInsertMs=performance.now()-originalIns;
    const ins=performance.now(); await client.query(`insert into ${combined} (${indexCols.map(qid).join(',')}) values (${fresh.map((_,i)=>`$${i+1}`).join(',')})`,fresh); const insertMs=performance.now()-ins;
    const newMemo=`combined probe ${sentinel}`;
    const profile=profiles(b.model.id,'memo',b.model.fields.memo).find(p=>p.mode==='substring')!;
    const newTokens=await searchTokens(sealer.ring(b.model.id),scopeId,profile,searchPieces(profile,newMemo));
    const oldMemo=originalRow[subs.find(x=>x.field==='memo')!.col.slice(1,-1)] as string[];
    const replacement=[...all]; for(const token of oldMemo){const i=replacement.indexOf(token);if(i>=0)replacement.splice(i,1);} replacement.push(...newTokens);
    const memoCol=subs.find(x=>x.field==='memo')!.col;
    const originalUpdate=performance.now();await client.query(`update ${original} set ${memoCol}=$1::bigint[] where scope_id=$2 and row_id=$3`,[newTokens,scopeId,sentinel]);const originalPartialUpdateMs=performance.now()-originalUpdate;
    const update=performance.now();await client.query(`update ${combined} set combined_tokens=$1::bigint[] where scope_id=$2 and row_id=$3`,[replacement,scopeId,sentinel]); const partialUpdateMs=performance.now()-update;
    await client.query('rollback');
    return {variant:skip?'skip':'next',originalInsertMs,combinedInsertMs:insertMs,originalPartialUpdateMs,combinedPartialUpdateMs:partialUpdateMs,method:'one SQL statement each in one transaction; existing row tokens copied; memo update replaces full combined array; rolled back',oldMemoTokens:oldMemo.length,newMemoTokens:newTokens.length};
  }catch(e){await client.query('rollback');throw e;}finally{client.release();}
}
try {
  await guard(); await mkdir(outputDir,{recursive:true});
  const storage=[];for(const skip of [false,true])storage.push(await fixture(skip));
  await writeFile(`${outputDir}/storage.json`,JSON.stringify(storage,null,2)+'\n');
  const collisions=[];
  for(const skip of [false,true]){
    const b=binding('customers',skip), table=full(b.storage.index!.name);
    const sub=Object.entries(b.storage.index!.profiles!).filter(([,v])=>v.mode==='substring');
    const prefixes=[];
    for(const [id,mapped] of sub){
      const rows=(await pool.query(`select distinct (token >> 32) as prefix from ${table} cross join lateral unnest(${qid(mapped.tokens)}) token`)).rows;
      prefixes.push({field:id.split('/')[0],prefixes:rows.map(r=>String(r.prefix))});
    }
    const overlaps=[];
    for(let i=0;i<prefixes.length;i++)for(let j=i+1;j<prefixes.length;j++){
      const shared=prefixes[i].prefixes.filter(x=>prefixes[j].prefixes.includes(x));
      if(shared.length)overlaps.push({fields:[prefixes[i].field,prefixes[j].field],shared});
    }
    collisions.push({variant:skip?'skip':'next',prefixes,overlaps});
  }
  await writeFile(`${outputDir}/collisions.json`,JSON.stringify(collisions,null,2)+'\n');
  const cost=[];for(const skip of [false,true])cost.push(await costs(skip));
  await writeFile(`${outputDir}/cost.json`,JSON.stringify(cost,null,2)+'\n');
  const report:any[]=[];const explains:any[]=[];
  for(const c of cases){
    const p:unknown[]=[scopeId];const where=plainWhere(c.node,p);
    const plain=()=>query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from ${source}.customers where scope_id=$1 and ${where} order by id limit 20`,p).then(r=>r.rows);
    const expected=await plain(); const paths:Record<string,()=>Promise<any[]>>={plain};
    for(const skip of [false,true]){
      const b=binding('customers',skip), stored=Object.entries(b.model.fields).flatMap(([f,s])=>profiles(b.model.id,f,s));
      const compiled=await compileSearch(compiledNode(c.node),b.definition,stored,sealer.ring(b.model.id),scopeId);
      const original=b.repo.repository.binding.rows.candidates;
      let combined=false; let lastStatement:ReturnType<typeof statement>|undefined;
      b.repo.repository.binding.rows.candidates=(executor,args)=>{
        if(!combined)return original(executor,args);
        lastStatement=statement(compiled,b,skip,args.limit<=200?{limit:args.limit,after:args.after?.id}:undefined);
        return original(executor,{...args,candidateSql:lastStatement});
      };
      const run=async(useCombined:boolean)=>{combined=useCombined;return (await b.repo.findMany({match:f=>match(c.node,f),select,limit:20,budgets})).items;};
      const tag=skip?'skip':'next';paths[tag]=()=>run(false);paths[`${tag}_combined`]=()=>run(true);
      const direct=statement(compiled,b,skip);
      const combinedTable=full(`customers${skip?'_skip':''}_combined_seal_index`);
      const oldTable=full(b.storage.index!.name);
      const originalStatement=(await import('../../src/adapters/postgres/search-sql.js')).candidateStatement(b.definition,b.storage,scopeId,compiled);
      for(const [layout,fragment,table] of [['original',originalStatement,oldTable],['combined',direct,combinedTable]] as const){
        const sql=`select id from ${full(`customers${skip?'_skip':''}`)} where scope_id=$1 and ${fragment.text} order by id limit 27`;
        const explain=(await pool.query(`explain (analyze,buffers,format json) ${sql}`,fragment.values)).rows[0]['QUERY PLAN'][0];
        explains.push({case:c.name,variant:tag,layout,table,statement:fragment,explain});
      }
    }
    for(const [name,fn] of Object.entries(paths))same(await fn(),expected,`${c.name}/${name}/initial`);
    for(let i=0;i<2;i++)for(const fn of Object.values(paths))await fn();
    const runs:Record<string,any[]>=Object.fromEntries(Object.keys(paths).map(k=>[k,[]]));
    for(let i=0;i<7;i++){
      const names=Object.keys(paths);if(i%2)names.reverse();
      for(const name of names){const v=await measure(paths[name]);same(v.rows,expected,`${c.name}/${name}/${i}`);runs[name].push({...v,rows:undefined});}
    }
    const summary=Object.fromEntries(Object.entries(runs).map(([name,samples])=>[name,Object.fromEntries(['totalMs','sqlMs','sqlCalls','candidates','authenticatedFields','returned'].map(k=>[k,median(samples.map(s=>s[k]))]))]));
    report.push({case:c.name,rows:expected.length,summary,runs});
    console.log(JSON.stringify({case:c.name,summary}));
    await writeFile(`${outputDir}/matrix.json`,JSON.stringify(report,null,2)+'\n');
    await writeFile(`${outputDir}/explain.json`,JSON.stringify(explains,null,2)+'\n');
  }
} finally { await pool.end(); }
