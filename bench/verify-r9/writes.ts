import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {and,eq} from 'drizzle-orm';
import {acquire,release,connect,model,save,fields,sealed,scope,assert,drizzle,normalize,measured,summarize,median} from './common.js';

const schema='test_r9_verify_write',h=model(schema),paths=['plain','product'] as const;
acquire();const pool=await connect(),db=drizzle(pool);
const result:any={started:new Date().toISOString(),schema,protocol:'One committed transaction per row for both paths; first sequence separate, two warmups and seven alternating sequences; resets and validation excluded',cases:[],errors:[],complete:false};
try{
 assert.equal((await pool.query('select to_regnamespace($1) n',[schema])).rows[0].n,null);
 await pool.query(`create schema ${schema}`);
 const snapshot=generateDrizzleJson({customers:h.table,customersSeal:h.seal}),migration=await generateMigration(generateDrizzleJson({}),snapshot);
 for(const statement of migration)await pool.query(statement);for(const statement of sealed.extraMigrationSql(h.seal))await pool.query(statement);
 await pool.query(`create table ${schema}.plain(id uuid primary key,scope_id uuid not null,${fields.flatMap(f=>[`${f}_plain text not null`,`${f}_norm text not null`]).join(',')})`);
 for(const f of fields){await pool.query(`create index plain_${f}_exact on ${schema}.plain(scope_id,${f}_norm,id)`);await pool.query(`create index plain_${f}_substring on ${schema}.plain using gin(${f}_norm gin_trgm_ops)`);}
 const source=(await pool.query(`select id,scope_id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id limit 1000`,[scope])).rows;
 assert.equal(source.length,1000);const original:any[]=source.slice(0,300).map(r=>({id:r.id,scopeId:r.scope_id,...Object.fromEntries(fields.map(f=>[f,r[f]]))}));
 const states=new Map<string,any>(original.map(r=>[r.id,{...r}]));
 const patches={memo:original.slice(0,100).map((r,i)=>({id:r.id,value:source[i+300].memo})),company:original.slice(100,200).map((r,i)=>{let j=(i+400)%source.length;while(source[j].company===r.company)j=(j+1)%source.length;return {id:r.id,value:source[j].company};})};
 const caseMap=Object.fromEntries(['insert','update_memo','update_company','delete'].map(op=>[op,{op,rows:op==='insert'?300:100,first:{},runs:{plain:[],product:[]},rowTimings:{plain:[],product:[]},summary:{}}]));
 result.session=(await pool.query('select pg_backend_pid() pid')).rows[0];result.plainLayout='raw text + app-normalized text, six exact B-tree and six pg_trgm GIN indexes';
 async function plainTransaction(fn:()=>Promise<any>){await pool.query('begin');try{const r=await fn();await pool.query('commit');return r;}catch(e){await pool.query('rollback');throw e;}}
 async function validate(path:typeof paths[number],expected:Map<string,any>){
  let rows:any[];
  if(path==='plain')rows=(await pool.query(`select id,scope_id as "scopeId",${fields.map(f=>`${f}_plain as ${f}`).join(',')} from ${schema}.plain order by id`)).rows;
  else {rows=await sealed.open(await db.select().from(h.table).orderBy(h.table.id));assert.equal((await pool.query(`select count(*)::int n from ${schema}.customers_seal_index`)).rows[0].n,expected.size);}
  assert.deepEqual(rows,[...expected.values()].sort((a,b)=>a.id.localeCompare(b.id)),`${path}: raw values and post-operation row count`);
  if(path==='product')for(const [field,value] of [['memo',patches.memo[0].value],['company',patches.company[0].value]]){
   const expectedCount=[...expected.values()].filter(r=>normalize(r[field])===normalize(value)).length;
   assert.equal(await sealed.count(db,h.seal,{scope,match:(m:any)=>m[field].eq(value)}),expectedCount,`${field} updated proof agrees`);
  }
 }
 for(let round=-3;round<7;round++)for(const path of (round+3)%2?[...paths].reverse():paths){
  if(path==='plain')await pool.query(`truncate ${schema}.plain`);else await pool.query(`truncate ${schema}.customers cascade`);
  states.clear();
  for(const op of ['insert','update_memo','update_company','delete']){
   const items=op==='insert'?original:op==='delete'?original.slice(200,300):op==='update_memo'?patches.memo:patches.company;
   const metrics:any[]=[];
   for(const item of items){
    const out=await measured(async()=>{
     if(op==='insert'){
      if(path==='product')return sealed.insert(db,h.seal,item as any);
      const params=[item.id,scope,...fields.flatMap(f=>[(item as any)[f],normalize((item as any)[f])])];
      return plainTransaction(()=>pool.query(`insert into ${schema}.plain(id,scope_id,${fields.flatMap(f=>[f+'_plain',f+'_norm']).join(',')}) values(${params.map((_,i)=>'$'+(i+1)).join(',')})`,params));
     }
     if(op==='delete'){
      if(path==='product')return db.transaction(tx=>tx.delete(h.table).where(and(eq(h.table.id,item.id),eq(h.table.scopeId,scope))));
      return plainTransaction(()=>pool.query(`delete from ${schema}.plain where id=$1 and scope_id=$2`,[item.id,scope]));
     }
     const field=op==='update_memo'?'memo':'company',value=(item as any).value;
     if(path==='product')return sealed.update(db,h.seal,{id:item.id,scopeId:scope},{[field]:value});
     return plainTransaction(()=>pool.query(`update ${schema}.plain set ${field}_plain=$3,${field}_norm=$4 where id=$1 and scope_id=$2`,[item.id,scope,value,normalize(value)]));
    });
    assert.deepEqual(out.pids,[result.session.pid]);metrics.push(out.metric);
    if(op==='insert')states.set(item.id,{...item});else if(op==='delete')states.delete(item.id);else states.get(item.id)[op==='update_memo'?'memo':'company']=(item as any).value;
   }
   const batch=Object.fromEntries(Object.keys(metrics[0]).map(k=>[k,metrics.reduce((s,m)=>s+m[k],0)]));batch.medianRowMs=median(metrics.map(m=>m.totalMs));batch.meanRowMs=batch.totalMs/items.length;
   const record=caseMap[op] as any;if(round===-3)record.first[path]=batch;if(round>=0){record.runs[path].push(batch);record.rowTimings[path].push(metrics);}
   await validate(path,states);result.cases=Object.values(caseMap);save('writes',result);console.log(JSON.stringify({round,path,op,rows:items.length,totalMs:batch.totalMs,medianRowMs:batch.medianRowMs,verified:states.size}));
  }
 }
 for(const record of Object.values(caseMap) as any[])for(const path of paths)record.summary[path]=summarize(record.runs[path]);
 result.complete=true;result.finished=new Date().toISOString();save('writes',result);
}catch(error){result.errors.push({at:new Date().toISOString(),message:String(error)});save('writes',result);throw error;}finally{await pool.end();release();}
