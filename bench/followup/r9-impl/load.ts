import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {drizzle} from 'drizzle-orm/node-postgres';
import {execFileSync} from 'node:child_process';
import {connect,save,fields,scope,schema,assert} from './common.js';
import {customers,customersSeal,sealed} from './product.js';
const commit=execFileSync('rtk',['proxy','git','rev-parse','HEAD'],{encoding:'utf8'}).trim();
const pool=await connect(4),db=drizzle(pool),result:any={started:new Date().toISOString(),commit,schema,loaded:0,complete:false,errors:[],method:'Public sealed.insert, four concurrent 500-row batches; progress timing is not a benchmark'};
try{
 assert.equal((await pool.query('select to_regnamespace($1) n',[schema])).rows[0].n,null,'Only create fresh owned schema');await pool.query(`create schema ${schema}`);
 const snapshot=generateDrizzleJson({customers,customersSeal}),migration=await generateMigration(generateDrizzleJson({}),snapshot),extra=sealed.extraMigrationSql(customersSeal);save('query-tuning','schema',{snapshot,migration,extra});
 for(const sql of migration)await pool.query(sql);for(const sql of extra)await pool.query(sql);
 const rows=(await pool.query(`select id,scope_id as "scopeId",${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows;assert.equal(rows.length,100000);
 const start=performance.now();for(let i=0;i<rows.length;i+=2000){await Promise.all(Array.from({length:4},(_,w)=>sealed.insert(db,customersSeal,rows.slice(i+w*500,i+(w+1)*500))));result.loaded=i+2000;result.elapsedMs=performance.now()-start;save('query-tuning','load',result);console.log(JSON.stringify({loaded:result.loaded,elapsedMs:Math.round(result.elapsedMs)}));}
 for(const table of ['customers','customers_seal_index']){await pool.query(`analyze ${schema}.${table}`);assert.equal((await pool.query(`select count(*)::int n from ${schema}.${table}`)).rows[0].n,100000);}
 const opened=await sealed.open(await db.select().from(customers).orderBy(customers.id).limit(100));for(let i=0;i<100;i++)for(const f of fields)assert.equal((opened[i] as any)[f],rows[i][f]);result.roundtripFields=600;result.complete=true;result.finished=new Date().toISOString();save('query-tuning','load',result);console.log('COMPLETE followup load');
}catch(e){result.errors.push(String(e));save('query-tuning','load',result);throw e;}finally{await pool.end();}
