import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {and,eq} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealed} from 'sealql/drizzle/v0.45';
import {acquire,release,connect,save,fields,scope,assert,readFileSync,OUT,normalize,median} from './common.js';
import {cipher,productSchema} from './product.js';
import {encode,candidateTokensAsync} from './research-codec.js';
import {compile} from './research-query.js';
import {measured,summarize} from './instrument.js';
const schema='test_final_return_write',sealed=createSealed({sealer:cipher}),table=pgSchema(schema).table('customers',{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),...Object.fromEntries(fields.map(f=>[f,sealed.text(f,{search:{exact:f==='company'?{bits:2}:true,substring:true}})]))}),seal=sealed.register(table,{row:'id',scope:'scopeId'});
const paths=['plain','research','product'] as const;
acquire();const pool=await connect(),db=drizzle(pool),result:any={started:new Date().toISOString(),commit:JSON.parse(readFileSync(`${OUT}/product-load.json`,'utf8')).commit,complete:false,errors:[],cases:[],protocol:'Task4 writes: independent insert300/update-memo100/delete100, one committed transaction per row; first separate, warmup2, rotate7; reset and verification excluded'};
const ctx=(f:string,id:string)=>({modelId:'customers',fieldId:f,keyScopeId:'global',scopeId:scope,rowId:id,spec:{type:'text' as const}});
async function tx(fn:()=>Promise<any>){await pool.query('begin');try{const r=await fn();await pool.query('commit');return r;}catch(error){await pool.query('rollback');throw error;}}
try{
 const final=JSON.parse(readFileSync(`${OUT}/measure.json`,'utf8'));assert.equal(final.complete,true,'Wait for final three-path query measurement');assert.deepEqual(final.variants,[]);result.commit=final.commit;
 assert.equal((await pool.query('select to_regnamespace($1) n',[schema])).rows[0].n,null);await pool.query(`create schema ${schema}`);
 const migration=await generateMigration(generateDrizzleJson({}),generateDrizzleJson({customers:table,customersSeal:seal}));for(const sql of migration)await pool.query(sql);for(const sql of sealed.extraMigrationSql(seal))await pool.query(sql);
 for(const [target,source] of [['plain','research_u.customers_plain'],['research_body','native_verify_main.customers'],['research_tags','research_u.pb_4_final']])await pool.query(`create table ${schema}.${target} (like ${source} including all)`);
 await pool.query(`alter table ${schema}.research_tags add foreign key(id) references ${schema}.research_body(id) on delete cascade`);
 const source=(await pool.query(`select id,scope_id,${fields.flatMap(f=>[f+'_plain',f+'_norm']).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id limit 400`,[scope])).rows;assert.equal(source.length,400);result.pid=(await pool.query('select pg_backend_pid() pid')).rows[0].pid;
 async function reset(path:typeof paths[number],rows:any[]){
  const body=path==='plain'?'plain':path==='research'?'research_body':'customers',tags=path==='research'?'research_tags':path==='product'?'customers_seal_index':null;
  await pool.query(`truncate ${schema}.${body}${tags?', '+schema+'.'+tags:''}`);
  if(!rows.length)return;const ids=rows.map(r=>r.id);
  if(path==='plain')await pool.query(`insert into ${schema}.plain select * from research_u.customers_plain where id=any($1::uuid[]) order by id`,[ids]);
  else{await tx(async()=>{await pool.query(`insert into ${schema}.${body} select * from ${path==='research'?'native_verify_main':productSchema}.customers where id=any($1::uuid[]) order by id`,[ids]);await pool.query(`insert into ${schema}.${tags} select * from ${path==='research'?'research_u.pb_4_final':productSchema+'.customers_seal_index'} where ${path==='research'?'id':'row_id'}=any($1::uuid[])`,[ids]);});}
 }
 async function researchField(f:string,value:string,id:string){const norm=normalize(value),proof=encode(f,norm),ce=await candidateTokensAsync(f,norm,'eq'),cs=await candidateTokensAsync(f,norm,'write');if(f==='company')ce[0]=String((BigInt(ce[0])>>30n)&3n);return {ct:Buffer.from(await cipher.seal(norm,ctx(f,id),cipher.ring('customers'))),values:[ce,cs,Buffer.from(proof.salt,'hex'),proof.jx,Buffer.from(proof.psalt,'hex'),proof.n,proof.stamps,proof.positions]};}
 async function write(path:typeof paths[number],op:string,row:any,value?:string){
  if(path==='product'){if(op==='insert')return sealed.insert(db,seal,{id:row.id,scopeId:scope,...Object.fromEntries(fields.map(f=>[f,row[f+'_plain']]))});if(op==='update')return sealed.update(db,seal,{id:row.id,scopeId:scope},{memo:value});return db.transaction(t=>t.delete(table).where(and(eq(table.id,row.id),eq(table.scopeId,scope))));}
  if(path==='plain')return tx(async()=>{if(op==='insert'){const values=[row.id,scope,...fields.map(f=>normalize(row[f+'_plain'])),Array.from(normalize(row.memo_plain)).length];return pool.query(`insert into ${schema}.plain values(${values.map((_,i)=>'$'+(i+1)).join(',')})`,values);}if(op==='update')return pool.query(`update ${schema}.plain set memo_norm=$2,memo_len=$3 where id=$1 and scope_id=$4`,[row.id,normalize(value!),Array.from(normalize(value!)).length,scope]);return pool.query(`delete from ${schema}.plain where id=$1 and scope_id=$2`,[row.id,scope]);});
  if(op==='delete')return tx(()=>pool.query(`delete from ${schema}.research_body where id=$1 and scope_id=$2`,[row.id,scope]));
  const prepared:Awaited<ReturnType<typeof researchField>>[]=[];for(const f of op==='insert'?fields:['memo'])prepared.push(await researchField(f,op==='insert'?row[f+'_plain']:value!,row.id));
  return tx(async()=>{if(op==='insert'){const body=[row.id,scope,...prepared.map(p=>p.ct)],tags=[row.id,scope,...prepared.flatMap(p=>p.values)];await pool.query(`insert into ${schema}.research_body(id,scope_id,${fields.map(f=>f+'_ct').join(',')}) values(${body.map((_,i)=>'$'+(i+1)).join(',')})`,body);return pool.query(`insert into ${schema}.research_tags values(${tags.map((_,i)=>'$'+(i+1)).join(',')})`,tags);}await pool.query(`update ${schema}.research_body set memo_ct=$2 where id=$1 and scope_id=$3`,[row.id,prepared[0].ct,scope]);const columns=['ce','cs','salt','jx','psalt','n','stamps','positions'].map(c=>c+'_memo');return pool.query(`update ${schema}.research_tags set ${columns.map((c,i)=>c+'=$'+(i+2)).join(',')} where id=$1 and scope_id=$10`,[row.id,...prepared[0].values,scope]);});
 }
 async function verify(path:typeof paths[number],expected:any[]){
  const rows=path==='product'?await sealed.open(await db.select().from(table).orderBy(table.id)):(await pool.query(`select * from ${schema}.${path==='plain'?'plain':'research_body'} order by id`)).rows;assert.equal(rows.length,expected.length);
  for(let i=0;i<rows.length;i++){const row:any=rows[i],want=expected[i];assert.equal(row.id,want.id);for(const f of fields){const value=path==='plain'?row[f+'_norm']:path==='product'?row[f]:await cipher.open(row[f+'_ct'],ctx(f,row.id),cipher.ring('customers'));assert.equal(normalize(String(value)),normalize(want[f+'_plain']));if(path==='product')assert.equal(value,want[f+'_plain']);}}
  if(path!=='plain')assert.equal((await pool.query(`select count(*)::int n from ${schema}.${path==='research'?'research_tags':'customers_seal_index'}`)).rows[0].n,expected.length);
  for(const [f,value] of [['company','서울서비스 담당'],['memo','서비스']]){const node:any={field:f,op:f==='company'?'eq':'contains',value},want=expected.filter(r=>f==='company'?normalize(r.company_plain)===normalize(value):normalize(r.memo_plain).includes(normalize(value))).length;let got:number;
   if(path==='product')got=await sealed.count(db,seal,{scope,match:(m:any)=>m[f][node.op](value)});else if(path==='plain')got=(await pool.query(`select count(*)::int n from ${schema}.plain where scope_id=$1 and ${f}_norm ${f==='company'?'=$2':'like $2'}`,[scope,f==='company'?normalize(value):'%'+normalize(value)+'%'])).rows[0].n;else{const q=await compile(node,'count');got=(await pool.query(q.text.replaceAll('research_u.pb_4_final',schema+'.research_tags'),q.params)).rows[0].n;}assert.equal(got,want);}
 }
 for(const op of ['insert','update','delete']){const count=op==='insert'?300:100,rows=source.slice(0,count),record:any={op,rows:count,first:{},runs:Object.fromEntries(paths.map(p=>[p,[]])),rowTimings:Object.fromEntries(paths.map(p=>[p,[]])),summary:{}};
  for(let round=-3;round<7;round++){const offset=(round+3)%3;for(const path of [...paths.slice(offset),...paths.slice(0,offset)]){
   await reset(path,op==='insert'?[]:rows);const metrics:Awaited<ReturnType<typeof measured>>['metric'][]=[];for(let i=0;i<rows.length;i++){const measuredRow=await measured(()=>write(path,op,rows[i],op==='update'?source[i+300].memo_plain:undefined));assert.deepEqual(measuredRow.pids,[result.pid]);metrics.push(measuredRow.metric);}
   const metric=Object.fromEntries(Object.keys(metrics[0]).map(k=>[k,metrics.reduce((sum,m)=>sum+(m as any)[k],0)]));metric.medianRowMs=median(metrics.map(m=>m.totalMs));metric.meanRowMs=metric.totalMs/count;
   const expected=op==='delete'?[]:rows.map((r,i)=>op==='update'?{...r,memo_plain:source[i+300].memo_plain}:r);await verify(path,expected);
   if(round===-3)record.first[path]=metric;if(round>=0){record.runs[path].push(metric);record.rowTimings[path].push(metrics);}console.log(JSON.stringify({op,round,path,totalMs:Math.round(metric.totalMs),verified:expected.length}));
  }}for(const path of paths)record.summary[path]=summarize(record.runs[path]);result.cases.push(record);save('writes',result);
 }
 result.complete=true;result.finished=new Date().toISOString();result.semanticNote='Research writes retain historical normalized ciphertext; product receives original plaintext and additionally verifies raw roundtrip; comparisons use identical normalized six-field values';save('writes',result);
}catch(error){result.errors.push(String(error));save('writes',result);throw error;}finally{await pool.end();release();}
