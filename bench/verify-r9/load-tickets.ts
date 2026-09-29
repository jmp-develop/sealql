import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {acquire,release,connect,save,sealed,scope,assert,drizzle} from './common.js';
import {tickets,ticketsSeal,joinSchema} from './join-schema.js';

acquire();const pool=await connect(8),db=drizzle(pool),report:any={started:new Date().toISOString(),schema:joinSchema,loaded:0,complete:false,source:'bench_realistic_100k.tickets memo_plain, original IDs/customer IDs/scope',fields:['memo'],errors:[]};
try{
 assert.equal((await pool.query('select to_regnamespace($1) n',[joinSchema])).rows[0].n,null);
 await pool.query(`create schema ${joinSchema}`);
 const snapshot=generateDrizzleJson({tickets,ticketsSeal}),migration=await generateMigration(generateDrizzleJson({}),snapshot);save('ticket-schema',{snapshot,migration,extra:sealed.extraMigrationSql(ticketsSeal)});
 for(const statement of migration)await pool.query(statement);for(const statement of sealed.extraMigrationSql(ticketsSeal))await pool.query(statement);
 const source=(await pool.query('select id,scope_id,customer_id,memo_plain from bench_realistic_100k.tickets where scope_id=$1 order by id',[scope])).rows;assert.equal(source.length,100000);
 const start=performance.now();
 for(let i=0;i<source.length;i+=1000){
  if(performance.now()-start>20*60*1000){report.limitReached=true;break;}
  await Promise.all(Array.from({length:8},async(_,worker)=>{const part=source.slice(i+worker*125,i+(worker+1)*125);if(part.length)await sealed.insert(db,ticketsSeal,part.map(r=>({id:r.id,scopeId:r.scope_id,customerId:r.customer_id,memo:r.memo_plain})));}));
  report.loaded=Math.min(i+1000,source.length);report.elapsedMs=performance.now()-start;save('ticket-load',report);if(report.loaded%5000===0)console.log(JSON.stringify({loaded:report.loaded,elapsedMs:Math.round(report.elapsedMs)}));
 }
 if(report.loaded===100000){
  await pool.query(`analyze ${joinSchema}.tickets`);await pool.query(`analyze ${joinSchema}.tickets_seal_index`);
  assert.equal((await pool.query(`select count(*)::int n from ${joinSchema}.tickets_seal_index`)).rows[0].n,100000);
  const opened=await sealed.open(await db.select().from(tickets).orderBy(tickets.id).limit(100));for(let i=0;i<100;i++){assert.equal(opened[i].memo,source[i].memo_plain);assert.equal(opened[i].customerId,source[i].customer_id);}
  report.complete=true;
 }
 report.finished=new Date().toISOString();save('ticket-load',report);
}catch(error){report.errors.push({message:String(error)});save('ticket-load',report);throw error;}finally{await pool.end();release();}
