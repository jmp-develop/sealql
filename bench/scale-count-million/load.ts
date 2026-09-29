import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {drizzle} from 'drizzle-orm/node-postgres';
import {createHash} from 'node:crypto';
import {connect,locked,save,status,schema,scope,fields,assert,readFileSync,delay} from './common.js';
import {sealed,customers,customersSeal} from './product.js';
import {normalize} from '../final-return/common.js';
export async function loadBase(progress:any){
 const pool=await connect(4),db=drizzle(pool);try{
  const rows=(await pool.query(`select id,scope_id as "scopeId",${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows;assert.equal(rows.length,100000);progress.sourceHash=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  await locked(async()=>{if(progress.createdSchema){assert.notEqual((await pool.query('select to_regnamespace($1) n',[schema])).rows[0].n,null);return;}assert.equal((await pool.query('select to_regnamespace($1) n',[schema])).rows[0].n,null);await pool.query(`create schema ${schema}`);progress.createdSchema=true;save('progress',progress);
   const snapshot=generateDrizzleJson({customers,customersSeal}),migration=await generateMigration(generateDrizzleJson({}),snapshot),extra=sealed.extraMigrationSql(customersSeal);save('schema',{snapshot,migration,extra});for(const sql of migration)await pool.query(sql);for(const sql of extra)await pool.query(sql);
   await pool.query(`create table ${schema}.customers_plain(id uuid primary key,scope_id uuid not null,${fields.map(f=>f+'_norm text not null').join(',')},memo_len int not null)`);
   await pool.query(`insert into ${schema}.customers_plain select id,scope_id,${fields.map(f=>f+'_norm').join(',')},char_length(memo_norm) from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope]);
   const meta=JSON.parse(readFileSync('bench/results/2026-09-29-task4/metadata.json','utf8'));for(const idx of meta.tables.find((t:any)=>t.schema==='research_u'&&t.table==='customers_plain').indexes)if(!idx.indexname.endsWith('_pkey'))await pool.query(idx.indexdef.replaceAll('research_u.',schema+'.'));
  });
  const existing=new Set((await pool.query(`select id from ${schema}.customers`)).rows.map(r=>r.id));assert.equal((await pool.query(`select count(*)::int n from ${schema}.customers_seal_index`)).rows[0].n,existing.size);const remaining=rows.filter(r=>!existing.has(r.id));assert.equal(existing.size+remaining.length,100000);
  const started=performance.now(),elapsedBefore=progress.loadElapsedMs??0;let active=progress.loadActiveMs??0;progress.phase='public-api-base-load';
  for(let offset=0;offset<remaining.length;offset+=2000){await locked(async()=>{const start=performance.now();await Promise.all(Array.from({length:4},(_,worker)=>{const batch=remaining.slice(offset+worker*500,offset+(worker+1)*500);return batch.length?sealed.insert(db,customersSeal,batch):undefined;}));active+=performance.now()-start;});progress.loaded=existing.size+Math.min(offset+2000,remaining.length);progress.loadActiveMs=active;progress.loadElapsedMs=elapsedBefore+performance.now()-started;progress.rowsPerSecond=progress.loaded/(active/1000);progress.estimatedBaseRemainingSeconds=(100000-progress.loaded)/progress.rowsPerSecond;save('progress',progress);console.log(JSON.stringify({loaded:progress.loaded,rowsPerSecond:progress.rowsPerSecond,remainingSeconds:progress.estimatedBaseRemainingSeconds}));
   if(progress.loaded===2000||progress.loaded%20000===0)status('100만 count 기준 적재 진행',`공개API ${progress.loaded}/100000행, 활성 적재 ${progress.rowsPerSecond.toFixed(1)}행/초, 기준10만 적재 잔여 약${Math.ceil(progress.estimatedBaseRemainingSeconds/60)}분(락 대기 제외 추정); 이후 SQL복제·VACUUM·측정을 진행합니다.`);
   await delay(1000);
  }
  await locked(async()=>{for(const table of ['customers','customers_seal_index','customers_plain']){await pool.query(`vacuum analyze ${schema}.${table}`);assert.equal((await pool.query(`select count(*)::int n from ${schema}.${table}`)).rows[0].n,100000);}const opened=await sealed.open(await db.select().from(customers).orderBy(customers.id).limit(100));for(let i=0;i<100;i++)for(const field of fields)assert.equal((opened[i] as any)[field],rows[i][field]);progress.baseRawRoundtrip=600;});
  progress.baseComplete=true;save('progress',progress);return rows.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))}));
 }finally{await pool.end();}
}
