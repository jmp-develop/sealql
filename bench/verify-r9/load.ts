import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {createHash} from 'node:crypto';
import {getTableColumns} from 'drizzle-orm';
import {acquire,release,connect,model,save,fields,sealed,scope,assert,drizzle,normalize,OUT} from './common.js';

const schema='test_r9_verify_main',h=model(schema),phase=process.argv[2]??'load';
assert.equal(phase,'load');acquire();const pool=await connect(8),db=drizzle(pool);
const report:any={started:new Date().toISOString(),schema,source:'bench_realistic_100k.customers *_plain, unmodified original values',api:'sealql/drizzle/v0.45 sealed.insert',loaded:0,complete:false,batch:1000,workers:8,chunk:125,errors:[]};
try{
 assert.equal((await pool.query('select to_regnamespace($1) n',[schema])).rows[0].n,null,'New verification schema must not already exist');
 const empty=generateDrizzleJson({}),snapshot=generateDrizzleJson({customers:h.table,customersSeal:h.seal});
 const migration=await generateMigration(empty,snapshot);save('schema',{schema,snapshot,migration,extra:sealed.extraMigrationSql(h.seal)});
 await pool.query(`create schema ${schema}`);
 for(const statement of migration)await pool.query(statement);
 for(const statement of sealed.extraMigrationSql(h.seal))await pool.query(statement);
 const source=(await pool.query(`select id,scope_id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows;
 assert.equal(source.length,100000);
 const baseline=(await pool.query(`select id,${fields.map(f=>`${f}_norm as ${f}`).join(',')} from research_u.customers_plain where scope_id=$1 order by id`,[scope])).rows;
 assert.equal(baseline.length,source.length);let mismatches=0;for(let i=0;i<source.length;i++){assert.equal(source[i].id,baseline[i].id);for(const f of fields)if(normalize(source[i][f])!==baseline[i][f])mismatches++;}
 assert.equal(mismatches,0,'Plain benchmark normalized values must agree with original fixture');report.sourceHash=createHash('sha256').update(JSON.stringify(source)).digest('hex');report.normalizedBaselineMismatches=mismatches;
 report.sourceSpaces=Object.fromEntries(fields.map(f=>[f,source.filter(r=>/\s/.test(r[f])).length]));report.sourceAsciiUpper=Object.fromEntries(fields.map(f=>[f,source.filter(r=>/[A-Z]/.test(r[f])).length]));
 save('load',report);const start=performance.now();
 for(let begin=0;begin<source.length;begin+=1000){
  await Promise.all(Array.from({length:8},async(_,worker)=>{const chunk=source.slice(begin+worker*125,Math.min(begin+(worker+1)*125,source.length));if(chunk.length)await sealed.insert(db,h.seal,chunk.map(r=>({id:r.id,scopeId:r.scope_id,...Object.fromEntries(fields.map(f=>[f,r[f]]))})) as any);}));
  report.loaded=Math.min(begin+1000,source.length);report.elapsedMs=performance.now()-start;save('load',report);console.log(JSON.stringify({loaded:report.loaded,elapsedMs:Math.round(report.elapsedMs),at:new Date().toISOString()}));
 }
 await pool.query(`analyze ${schema}.customers`);await pool.query(`analyze ${schema}.customers_seal_index`);
 for(const table of ['customers','customers_seal_index'])assert.equal((await pool.query(`select count(*)::int n from ${schema}.${table}`)).rows[0].n,100000);
 const opened=await sealed.open(await db.select().from(h.table).orderBy(h.table.id).limit(100));
 for(let i=0;i<opened.length;i++)for(const f of fields)assert.equal(opened[i][f],source[i][f],`Raw ${f} value must round-trip`);
 report.rawSampleRoundtrip=opened.length;report.complete=true;report.finished=new Date().toISOString();save('load',report);console.log('CUSTOMERS READY');
}catch(error){report.errors.push({at:new Date().toISOString(),message:String(error)});save('load',report);throw error;}finally{await pool.end();release();}
