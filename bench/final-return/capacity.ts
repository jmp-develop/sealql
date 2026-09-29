import {acquire,release,connect,save,assert,readFileSync,OUT} from './common.js';
import {productSchema} from './product.js';
acquire();const pool=await connect();try{
 const final=JSON.parse(readFileSync(`${OUT}/measure.json`,'utf8'));assert.equal(final.complete,true,'Wait for final three-path query measurement');assert.deepEqual(final.variants,[]);
 const result:any={at:new Date().toISOString(),complete:false,commit:final.commit,tables:[],paths:{plain:['research_u.customers_plain'],research:['native_verify_main.customers','research_u.pb_4_final'],product:[productSchema+'.customers',productSchema+'.customers_seal_index']}};
 for(const relation of [...new Set(Object.values(result.paths).flat())] as string[]){
  const row=(await pool.query(`select pg_relation_size(c.oid)::text heap,(pg_relation_size(c.oid,'fsm')+pg_relation_size(c.oid,'vm'))::text heap_aux,pg_indexes_size(c.oid)::text indexes,pg_total_relation_size(c.oid)::text total,case when reltoastrelid=0 then 0 else pg_relation_size(reltoastrelid) end::text toast_heap,case when reltoastrelid=0 then 0 else pg_indexes_size(reltoastrelid) end::text toast_indexes,case when reltoastrelid=0 then 0 else pg_relation_size(reltoastrelid,'fsm')+pg_relation_size(reltoastrelid,'vm') end::text toast_aux from pg_class c where oid=$1::regclass`,[relation])).rows[0];
  const rows=(await pool.query(`select count(*)::int n from ${relation}`)).rows[0].n;assert.equal(rows,100000);const sizes=Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Number(v)]));assert.equal(sizes.total,sizes.heap+sizes.heap_aux+sizes.indexes+sizes.toast_heap+sizes.toast_indexes+sizes.toast_aux);
  const [schema,table]=relation.split('.'),indexes=(await pool.query('select indexname,indexdef,pg_relation_size((quote_ident(schemaname)||\'.\'||quote_ident(indexname))::regclass)::text bytes from pg_indexes where schemaname=$1 and tablename=$2 order by indexname',[schema,table])).rows;
  result.tables.push({relation,rows,...sizes,indexBytes:sizes.indexes,bytesPerRow:sizes.total/rows,indexes});
 }
 result.totals=Object.fromEntries(Object.entries(result.paths).map(([path,relations])=>[path,(relations as string[]).reduce((sum,relation)=>sum+result.tables.find((t:any)=>t.relation===relation).total,0)]));
 result.note='Research includes one full native ciphertext body plus rebuilt historical proof table; protected native body is read-only and shared physically, but its complete size is charged to the research representation';result.complete=true;save('capacity',result);console.log(JSON.stringify(result.totals));
}finally{await pool.end();release();}
