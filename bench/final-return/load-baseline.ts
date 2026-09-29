import {connect,save,fields,scope,normalize,assert,readFileSync,OUT} from './common.js';
import {candidateTokens,encode} from './research-codec.js';
import {createHash} from 'node:crypto';
// Coordinator explicitly permits this ingestion alongside correctness tests.
// Progress elapsed time is not a benchmark; only later timed measurements lock.
const pool=await connect();
const result:any={started:new Date().toISOString(),loaded:0,complete:false,errors:[],source:'bench_realistic_100k raw values; native_verify_main task4 candidate tokens and ciphertext read-only',method:'Task4 pb_4_final format and function, directly populated without unused intermediate B/improved tables'};
try{
 const columns=JSON.parse(readFileSync(`${OUT}/research-columns.json`,'utf8'));
 for(const name of ['research_u.customers_plain','research_u.pb_4_final'])assert.equal((await pool.query('select to_regclass($1) r',[name])).rows[0].r,null,`${name} must be new`);
 await pool.query('create schema if not exists research_u');
 const source=(await pool.query(`select id,scope_id,${fields.flatMap(f=>[f+'_plain',f+'_norm']).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows;assert.equal(source.length,100000);
 for(const r of source)for(const f of fields)assert.equal(normalize(r[f+'_plain']),r[f+'_norm']);
 result.normalizationChecked=600000;result.sourceHash=createHash('sha256').update(JSON.stringify(source)).digest('hex');
 assert.equal((await pool.query('select count(*)::int n from native_verify_main.customers_seal_index where scope_id=$1',[scope])).rows[0].n,100000);
 assert.equal((await pool.query('select count(*)::int n from bench_realistic_100k.customers f join native_verify_main.customers c on c.id=f.id and c.scope_id=f.scope_id join native_verify_main.customers_seal_index i on i.row_id=f.id and i.scope_id=f.scope_id where f.scope_id=$1',[scope])).rows[0].n,100000);
 await pool.query(`create table research_u.customers_plain(id uuid primary key,scope_id uuid not null,${fields.map(f=>f+'_norm text not null').join(',')},memo_len int not null)`);
 await pool.query(`insert into research_u.customers_plain select id,scope_id,${fields.map(f=>f+'_norm').join(',')},char_length(memo_norm) from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope]);
 const historic=JSON.parse(readFileSync('bench/results/2026-09-29-task4/metadata.json','utf8'));
 for(const idx of historic.tables.find((t:any)=>t.schema==='research_u'&&t.table==='customers_plain').indexes)if(!idx.indexname.endsWith('_pkey'))await pool.query(idx.indexdef);
 await pool.query(readFileSync('bench/final-return/research-function.sql','utf8'));
 await pool.query(`create table research_u.pb_4_final(id uuid not null,scope_id uuid not null,${fields.flatMap(f=>[`ce_${f} bigint[] not null`,`cs_${f} bigint[] not null`,`salt_${f} bytea not null`,`jx_${f} bigint not null`,`psalt_${f} bytea not null`,`n_${f} int not null`,`stamps_${f} bigint[] not null`,`positions_${f} int[] not null`]).join(',')})`);
 const start=performance.now();let checked=0;
 for(let offset=0;offset<source.length;offset+=500){
  const rows=source.slice(offset,offset+500),sample=rows[0],native=(await pool.query(`select ${fields.flatMap(f=>[`"${columns[f].ce}" ce_${f}`,`"${columns[f].cs}" cs_${f}`]).join(',')} from native_verify_main.customers_seal_index where row_id=$1 and scope_id=$2`,[sample.id,scope])).rows[0];
  for(const f of fields){assert.deepEqual(candidateTokens(f,sample[f+'_norm'],'eq'),native['ce_'+f]);for(const token of candidateTokens(f,sample[f+'_norm'],'contains'))assert(native['cs_'+f].includes(token));checked++;}
  const cache=new Map<string,Buffer>(),values=rows.map(r=>({id:r.id,v:Object.fromEntries(fields.map(f=>[f,encode(f,r[f+'_norm'],cache)]))}));
  await pool.query(`insert into research_u.pb_4_final select b.row_id,b.scope_id,${fields.flatMap(f=>[f==='company'?`array[(b."${columns[f].ce}"[1]>>30)&3]`:`b."${columns[f].ce}"`,`b."${columns[f].cs}"`,`decode(x->'v'->'${f}'->>'salt','hex')`,`(x->'v'->'${f}'->>'jx')::bigint`,`decode(x->'v'->'${f}'->>'psalt','hex')`,`(x->'v'->'${f}'->>'n')::int`,`array(select jsonb_array_elements_text(x->'v'->'${f}'->'stamps')::bigint)`,`array(select jsonb_array_elements_text(x->'v'->'${f}'->'positions')::int)`]).join(',')} from jsonb_array_elements($1::jsonb) x join native_verify_main.customers_seal_index b on b.row_id=(x->>'id')::uuid and b.scope_id=$2`,[JSON.stringify(values),scope]);
  result.loaded=offset+rows.length;result.elapsedMs=performance.now()-start;result.candidateFieldsChecked=checked;save('baseline-load',result);if(result.loaded%5000===0)console.log(JSON.stringify({loaded:result.loaded,elapsedMs:Math.round(result.elapsedMs)}));
 }
 await pool.query('alter table research_u.pb_4_final add primary key(id)');
 for(const idx of historic.tables.find((t:any)=>t.schema==='research_u'&&t.table==='pb_4_final').indexes)if(!idx.indexname.endsWith('_pkey'))await pool.query(idx.indexdef);
 for(const table of ['customers_plain','pb_4_final']){await pool.query(`vacuum analyze research_u.${table}`);assert.equal((await pool.query(`select count(*)::int n from research_u.${table}`)).rows[0].n,100000);}
 result.finished=new Date().toISOString();result.complete=true;save('baseline-load',result);console.log(JSON.stringify({complete:true,loaded:result.loaded,candidateFieldsChecked:checked}));
}catch(error){result.errors.push(String(error));save('baseline-load',result);throw error;}finally{await pool.end();}
