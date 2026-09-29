import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {getTableColumns} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/node-postgres';
import {spawnSync} from 'node:child_process';
import {connect,save,fields,scope,assert,readFileSync,OUT} from './common.js';
import {productSchema,customers,customersSeal,sealed} from './product.js';
const requested=process.argv[process.argv.indexOf('--commit')+1];assert(process.argv.includes('--commit')&&/^[a-f0-9]{7,40}$/.test(requested),'Committed r9-impl revision required');
const head=spawnSync('rtk',['proxy','git','rev-parse','HEAD'],{encoding:'utf8'});assert.equal(head.status,0);const commit=head.stdout.trim();assert(commit.startsWith(requested));
assert(!Object.values(getTableColumns(customersSeal)).some(c=>/^(single|word)_/.test(c.name)),'Build the new stream-removal product before loading');
const pool=await connect(4),db=drizzle(pool),result:any={started:new Date().toISOString(),commit,schema:productSchema,loaded:0,complete:false,errors:[],method:'Public sealed.insert, four concurrent 500-row batches; raw fixture values retained; ingestion timing is progress only'};
try{
 assert.equal(JSON.parse(readFileSync(`${OUT}/baseline-load.json`,'utf8')).complete,true);
 assert.equal((await pool.query('select to_regnamespace($1) n',[productSchema])).rows[0].n,null,'Only a fresh product schema may be loaded');
 await pool.query(`create schema ${productSchema}`);
 const snapshot=generateDrizzleJson({customers,customersSeal}),migration=await generateMigration(generateDrizzleJson({}),snapshot),extra=sealed.extraMigrationSql(customersSeal);save('product-schema',{snapshot,migration,extra});
 for(const sql of migration)await pool.query(sql);for(const sql of extra)await pool.query(sql);
 const rows=(await pool.query(`select id,scope_id as "scopeId",${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows;assert.equal(rows.length,100000);
 const start=performance.now();for(let i=0;i<rows.length;i+=2000){await Promise.all(Array.from({length:4},(_,worker)=>{const batch=rows.slice(i+worker*500,i+(worker+1)*500);return batch.length?sealed.insert(db,customersSeal,batch):undefined;}));result.loaded=Math.min(i+2000,rows.length);result.elapsedMs=performance.now()-start;save('product-load',result);console.log(JSON.stringify({loaded:result.loaded,elapsedMs:Math.round(result.elapsedMs)}));}
 for(const name of ['customers','customers_seal_index']){await pool.query(`analyze ${productSchema}.${name}`);assert.equal((await pool.query(`select count(*)::int n from ${productSchema}.${name}`)).rows[0].n,100000);}
 const opened=await sealed.open(await db.select().from(customers).orderBy(customers.id).limit(100));for(let i=0;i<100;i++)for(const f of fields)assert.equal((opened[i] as any)[f],rows[i][f]);
 result.rawRoundtrip=600;result.finished=new Date().toISOString();result.complete=true;save('product-load',result);
}catch(error){result.errors.push(String(error));save('product-load',result);throw error;}finally{await pool.end();}
