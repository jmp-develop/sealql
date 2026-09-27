/** G0: SQL-only parent-token placement probe. All mutable tables are disposable derivatives. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { compileSearch, type CompiledSearch, verifySearch, type SearchNode } from '../../src/core/search-predicate.js';
import { normalizeText } from '../../src/core/search-tokens.js';
import { profiles } from '../../src/core/search-tokens.js';
import { candidateStatement } from '../../src/adapters/postgres/search-sql.js';
import { binding, fields, guard, pool, schema, scopeId, sealer, source } from './common.js';

const out='bench/results/2026-09-27-g0-token-placement';
const current='customers_skip_product_multi', companion=`${current}_seal_index`;
const parent='g0_parent_tokens', writeCurrent='g0_write_current', writeParent='g0_write_parent', writeIndex=`${writeCurrent}_seal_index`;
const q=(s:string)=>`"${s.replaceAll('"','""')}"`, fq=(s:string)=>`${q(schema)}.${q(s)}`;
const base=binding('customers',true);
const tokenEntries=Object.values(base.storage.index!.profiles!);
const tokenCols=[...new Set(tokenEntries.map(x=>x.tokens))];
const subCols=[...new Set(tokenEntries.filter(x=>x.mode==='substring').map(x=>x.tokens))];
const exactCols=[...new Set(tokenEntries.filter(x=>x.mode==='exact').map(x=>x.tokens))];
const ctCols=fields.map(f=>`${f}_ct`);
const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
async function timed(sql:string,values:unknown[]=[]){const t=performance.now();const result=await pool.query(sql,values);return {ms:performance.now()-t,rows:result.rows};}
async function exists(name:string){return !!(await pool.query('select to_regclass($1) rel',[`${schema}.${name}`])).rows[0].rel;}
async function drop(name:string){await pool.query(`drop table if exists ${fq(name)} cascade`);}
async function count(name:string){return Number((await pool.query(`select count(*) n from ${fq(name)}`)).rows[0].n);}
async function setup(){
  await guard();
  assert(await exists(current));assert(await exists(companion));
  assert.equal(await count(current),100000);assert.equal(await count(companion),100000);
  assert.equal(Number((await pool.query(`select count(*) n from ${source}.customers where scope_id=$1`,[scopeId])).rows[0].n),100000);
  for(const name of [writeCurrent,writeParent,parent])assert(!(await exists(name)),`${name} must not preexist`);
  assert(!(await exists(writeIndex)),`${writeIndex} must not preexist`);
  await pool.query(`create table ${fq(parent)} as select p.*,${tokenCols.map(x=>`i.${q(x)}`).join(',')} from ${fq(current)} p join ${fq(companion)} i on i.scope_id=p.scope_id and i.row_id=p.id`);
  assert.equal(await count(parent),100000);
  await pool.query(`alter table ${fq(parent)} add primary key(scope_id,id)`);
  for(const col of exactCols)await pool.query(`create index ${q(`g0_parent_${col}_bt`)} on ${fq(parent)}(scope_id,(${q(col)}[1]),id)`);
  await pool.query(`create index ${q('g0_parent_multi_gin')} on ${fq(parent)} using gin(${subCols.map(q).join(',')})`);
  for(const col of subCols)await pool.query(`alter table ${fq(parent)} alter column ${q(col)} set statistics 1000`);
  await pool.query(`analyze ${fq(parent)}`);
  await pool.query(`create table ${fq(writeParent)} (like ${fq(parent)} including indexes)`);
  await pool.query(`create table ${fq(writeCurrent)} (like ${fq(current)} including indexes)`);
  await pool.query(`create table ${fq(writeIndex)} (like ${fq(companion)} including indexes)`);
}
const L=(op:'eq'|'contains'|'startsWith'|'endsWith',field:string,value:string):SearchNode=>({op,field,value});
const A=(...children:SearchNode[]):SearchNode=>({op:'all',children});
const O=(...children:SearchNode[]):SearchNode=>({op:'any',children});
const cases:{name:string;node:SearchNode;limit?:number;respectWords?:boolean}[]=[
  {name:'exact_common',node:L('eq','company','서울서비스 담당')},{name:'exact_mid',node:L('eq','company','서울서비스 중앙지사')},
  {name:'exact_one',node:L('eq','phone','42-5748-1542')},{name:'exact_zero',node:L('eq','phone','99-0000-0000')},
  {name:'sub2_common',node:L('contains','company','서비')},{name:'sub_mid',node:L('contains','address','세종대로')},
  {name:'sub_mid_space',node:L('contains','address','세종대로 25')},{name:'sub_rare',node:L('contains','memo','푸른달')},
  {name:'sub_long',node:L('contains','memo','상세 안내와 확인 내용 상세 안내와')},{name:'sub_name_suffix',node:L('contains','name','pshxt')},
  {name:'sub_zero',node:L('contains','memo','없는표식')},{name:'starts',node:L('startsWith','address','서울')},
  {name:'ends',node:L('endsWith','email','biz.test')},{name:'and2',node:A(L('eq','company','서울서비스 담당'),L('contains','memo','서비스'))},
  {name:'and4',node:A(L('eq','company','서울서비스 담당'),L('contains','address','서울'),L('contains','memo','상담'),L('contains','email','service'))},
  {name:'and6',node:A(L('contains','name','민서'),L('contains','phone','-5'),L('contains','address','서울'),L('contains','memo','서비스'),L('contains','email','test'),L('eq','company','서울서비스 담당'))},
  {name:'or2',node:O(L('eq','company','서울서비스 담당'),L('contains','memo','푸른달'))},
  {name:'or3',node:O(L('eq','phone','42-5748-1542'),L('eq','phone','21-7100-5875'),L('contains','name','pshxt'))},
  {name:'drain101',node:L('contains','memo','푸른달'),limit:200},
  {name:'word_boundary',node:{op:'contains',field:'memo',value:'서비스 상담',respectWords:true},respectWords:true},
  {name:'word_inside_longer',node:{op:'contains',field:'memo',value:'비스 상',respectWords:true},respectWords:true},
];
function directWhere(node:CompiledSearch, params:unknown[]):string{
  if(node.op==='all'||node.op==='any')return '('+node.children.map(x=>directWhere(x,params)).join(node.op==='all'?' and ':' or ')+')';
  const {profile,tokens}=node.leaf;const mapped=base.storage.index!.profiles![profile.indexId];assert(mapped);const col=q(mapped.tokens);
  if(mapped.mode==='exact'){assert.equal(tokens.length,1);params.push(tokens[0]);return `(${col})[1]=$${params.length}::bigint`;}
  params.push(tokens);return `${col} @> $${params.length}::bigint[]`;
}
function plainWhere(node:SearchNode,params:unknown[]):string{
  if(node.op==='all'||node.op==='any')return '('+node.children.map(x=>plainWhere(x,params)).join(node.op==='all'?' and ':' or ')+')';
  const v=normalizeText(node.value as string,'legacy-text-v1');assert(!/[%_\\]/.test(v));params.push(v);const p=`$${params.length}`;
  return node.op==='eq'?`${node.field}_norm=${p}`:node.op==='contains'?`${node.field}_norm like '%'||${p}||'%'`:node.op==='startsWith'?`${node.field}_norm like ${p}||'%'`:`${node.field}_norm like '%'||${p}`;
}
async function searches(){
  const result=[];const stored=Object.entries(base.model.fields).flatMap(([f,s])=>profiles(base.model.id,f,s));
  for(const c of cases){
    const compiled=await compileSearch(c.node,base.definition,stored,sealer.ring(base.model.id),scopeId);
    const limit=c.limit??27;const st=candidateStatement(base.definition,base.storage,scopeId,compiled);
    const currentPredicate=st.text.replaceAll('"customers_skip"."id"',`${q(current)}."id"`).replaceAll('"customers_skip_seal_index"',q(companion));
    const currentSql=`select id from ${fq(current)} where scope_id='${scopeId}' and ${currentPredicate} order by id limit ${limit}`;
    const params:unknown[]=[scopeId];const parentSql=`select id from ${fq(parent)} where scope_id=$1 and ${directWhere(compiled,params)} order by id limit ${limit}`;
    const plainParams:unknown[]=[scopeId];const plainSql=`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from ${source}.customers where scope_id=$1 and ${plainWhere(c.node,plainParams)} order by id`;
    const plain=(await pool.query(plainSql,plainParams)).rows;
    const oracle=[];for(const row of plain)if(await verifySearch(compiled,async f=>row[f]))oracle.push(row.id);
    const runs:{current:number[];parent:number[]}={current:[],parent:[]};let currentIds:string[]=[],parentIds:string[]=[];
    for(let i=0;i<9;i++)for(const variant of (i%2?['parent','current']:['current','parent']) as ('current'|'parent')[]){
      const x=await timed(variant==='current'?currentSql:parentSql,variant==='current'?st.values:params);
      if(i>=2)runs[variant].push(x.ms);
      if(variant==='current')currentIds=x.rows.map(r=>r.id);else parentIds=x.rows.map(r=>r.id);
    }
    assert.deepEqual(parentIds,currentIds,`${c.name} candidate IDs`);
    const candidateSet=new Set(parentIds);
    assert(oracle.slice(0,Math.min(20,oracle.length)).every(id=>candidateSet.has(id)),`${c.name} plaintext hits in candidate page`);
    result.push({case:c.name,plainHits:oracle.length,candidates:parentIds.length,medianMs:{current:median(runs.current),parent:median(runs.parent)},runs,sql:{current:currentSql,parent:parentSql}});
    console.error(`search ${c.name} done`);
  }
  return result;
}
async function reads(){
  const projection=['scope_id','id','revision',...ctCols].map(q).join(',');
  const result=[];
  for(const selected of ['all','withoutTokens'] as const){
    const runs:{current:number[];parent:number[]}={current:[],parent:[]};
    for(let i=0;i<9;i++)for(const variant of (i%2?['parent','current']:['current','parent']) as ('current'|'parent')[]){
      const table=variant==='current'?current:parent;
      const sql=`select ${selected==='all'?'*':projection} from ${fq(table)} where scope_id=$1 order by id limit 20`;
      const x=await timed(sql,[scopeId]);assert.equal(x.rows.length,20);
      if(i>=2)runs[variant].push(x.ms);
    }
    const a=median(runs.current),b=median(runs.parent);
    result.push({selection:selected,medianMs:{current:a,parent:b},deltaMs:b-a,deltaPercent:(b/a-1)*100,gateExceeded:(b-a)>0.3||(b/a-1)>0.2,runs});
  }
  return result;
}
async function writes(){
  const sourceRows=(await pool.query(`select p.*,${tokenCols.map(x=>`i.${q(x)}`).join(',')} from ${fq(current)} p join ${fq(companion)} i on i.scope_id=p.scope_id and i.row_id=p.id order by p.id limit 1000`)).rows;
  assert.equal(sourceRows.length,1000);
  const cols=['scope_id','id','revision',...ctCols],parentCols=[...cols,...tokenCols],indexCols=['scope_id','row_id',...tokenCols];
  const insert=(table:string,names:string[])=>`insert into ${fq(table)} (${names.map(q).join(',')}) values (${names.map((_,i)=>`$${i+1}`).join(',')})`;
  const memoTokens=profiles(base.model.id,'memo',base.model.fields.memo).map(p=>base.storage.index!.profiles![p.indexId].tokens);
  assert.equal(memoTokens.length,2);
  const sqls={current:{parentInsert:insert(writeCurrent,cols),indexInsert:insert(writeIndex,indexCols),updateParent:`update ${fq(writeCurrent)} set memo_ct=$3,revision=2 where scope_id=$1 and id=$2`,updateIndex:`update ${fq(writeIndex)} set ${memoTokens.map((x,i)=>`${q(x)}=$${i+3}`).join(',')} where scope_id=$1 and row_id=$2`,deleteIndex:`delete from ${fq(writeIndex)} where scope_id=$1 and row_id=$2`,deleteParent:`delete from ${fq(writeCurrent)} where scope_id=$1 and id=$2`},parent:{insert:insert(writeParent,parentCols),update:`update ${fq(writeParent)} set memo_ct=$3,${memoTokens.map((x,i)=>`${q(x)}=$${i+4}`).join(',')},revision=2 where scope_id=$1 and id=$2`,delete:`delete from ${fq(writeParent)} where scope_id=$1 and id=$2`}};
  async function cycle(variant:'current'|'parent'){
    const ms={insert:0,update:0,delete:0};
    for(const row of sourceRows){
      let t=performance.now();
      if(variant==='current'){await pool.query(sqls.current.parentInsert,cols.map(x=>row[x]));await pool.query(sqls.current.indexInsert,indexCols.map(x=>x==='row_id'?row.id:row[x]));}
      else await pool.query(sqls.parent.insert,parentCols.map(x=>row[x]));ms.insert+=performance.now()-t;
    }
    for(const row of sourceRows){let t=performance.now();
      if(variant==='current'){await pool.query(sqls.current.updateParent,[scopeId,row.id,row.memo_ct]);await pool.query(sqls.current.updateIndex,[scopeId,row.id,...memoTokens.map(x=>row[x])]);}
      else await pool.query(sqls.parent.update,[scopeId,row.id,row.memo_ct,...memoTokens.map(x=>row[x])]);ms.update+=performance.now()-t;
    }
    for(const row of sourceRows){let t=performance.now();
      if(variant==='current'){await pool.query(sqls.current.deleteIndex,[scopeId,row.id]);await pool.query(sqls.current.deleteParent,[scopeId,row.id]);}
      else await pool.query(sqls.parent.delete,[scopeId,row.id]);ms.delete+=performance.now()-t;
    }
    assert.equal(await count(variant==='current'?writeCurrent:writeParent),0);
    if(variant==='current')assert.equal(await count(writeIndex),0);
    return ms;
  }
  const runs:{current:Record<string,number>[];parent:Record<string,number>[]}={current:[],parent:[]};
  for(let i=0;i<9;i++)for(const variant of (i%2?['parent','current']:['current','parent']) as ('current'|'parent')[]){const x=await cycle(variant);if(i>=2)runs[variant].push(x);console.error(`write ${i+1}/9 ${variant}`);}
  return {samplesPerOperation:1000,medianMs:Object.fromEntries(['current','parent'].map(v=>[v,Object.fromEntries(['insert','update','delete'].map(k=>[k,median(runs[v as 'current'|'parent'].map(x=>x[k]))]))])),runs};
}
async function sizes(){const names=[current,companion,parent];const rows=[];for(const name of names){const x=(await pool.query('select pg_relation_size($1::regclass) table_bytes,pg_indexes_size($1::regclass) index_bytes,pg_total_relation_size($1::regclass) total_bytes',[`${schema}.${name}`])).rows[0];rows.push({name,...Object.fromEntries(Object.entries(x).map(([k,v])=>[k,Number(v)]))});}return rows;}
let created=false;
try{await setup();created=true;await mkdir(out,{recursive:true});const result={environment:{host:'127.0.0.1',port:56439,scopeId,fixture:`${schema}.${current}`,source:`${source}.customers`,warmup:2,alternatingRuns:7},read:await reads(),search:await searches(),write:await writes(),size:await sizes()};await writeFile(`${out}/measurements.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({gate:result.read.map(x=>({selection:x.selection,exceeded:x.gateExceeded,deltaMs:x.deltaMs,deltaPercent:x.deltaPercent}))}));}
finally{if(created){for(const name of [writeIndex,writeCurrent,writeParent,parent])await drop(name);}await pool.end();}
