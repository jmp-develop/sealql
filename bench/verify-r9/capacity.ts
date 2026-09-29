import {getTableColumns} from 'drizzle-orm';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from 'sealql';
import {createSealed} from 'sealql/drizzle/v0.45';
import {acquire,release,connect,model,save,archive,fields,sealed,scope,assert,readFileSync,OUT} from './common.js';

const schema='test_r9_verify_main',h=model(schema);
acquire();const pool=await connect();
archive('capacity');
try{
 assert.equal(JSON.parse(readFileSync(`${OUT}/load.json`,'utf8')).complete,true);
 const result:any={at:new Date().toISOString(),tables:[],streams:[],indexes:[],catalog:[],functionBodies:[],correlations:[]};
 for(const relation of ['research_u.customers_plain',schema+'.customers',schema+'.customers_seal_index']){
  const row=(await pool.query(`select c.oid,c.reltoastrelid,pg_relation_size(c.oid)::text heap,pg_relation_size(c.oid,'fsm')::text heap_fsm,pg_relation_size(c.oid,'vm')::text heap_vm,pg_indexes_size(c.oid)::text indexes,pg_total_relation_size(c.oid)::text total,case when c.reltoastrelid=0 then 0 else pg_relation_size(c.reltoastrelid) end::text toast_heap,case when c.reltoastrelid=0 then 0 else pg_indexes_size(c.reltoastrelid) end::text toast_indexes,case when c.reltoastrelid=0 then 0 else pg_relation_size(c.reltoastrelid,'fsm')+pg_relation_size(c.reltoastrelid,'vm') end::text toast_aux from pg_class c where c.oid=$1::regclass`,[relation])).rows[0];
  const count=(await pool.query(`select count(*)::int n from ${relation}`)).rows[0].n;assert.equal(count,100000);
  const sizes=Object.fromEntries(Object.entries(row).filter(([k])=>!['oid','reltoastrelid'].includes(k)).map(([k,v])=>[k,Number(v)]));
  result.tables.push({relation,rows:count,...sizes,bytesPerRow:sizes.total/count});
  const [schemaName,tableName]=relation.split('.');
  result.indexes.push(...(await pool.query("select schemaname,tablename,indexname,indexdef,pg_relation_size((quote_ident(schemaname)||'.'||quote_ident(indexname))::regclass)::text bytes from pg_indexes where schemaname=$1 and tablename=$2 order by indexname",[schemaName,tableName])).rows);
  result.catalog.push({relation,columns:(await pool.query('select attname,attstorage,attstattarget,format_type(atttypid,atttypmod) type from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped order by attnum',[relation])).rows});
  result.correlations.push(...(await pool.query("select schemaname,tablename,attname,correlation from pg_stats where schemaname=$1 and tablename=$2 and attname in ('id','row_id')",[schemaName,tableName])).rows);
 }
 const actualColumns=new Set(Object.values(getTableColumns(h.seal)).map(c=>c.name));
 for(const f of fields){
  const local=createSealed({sealer:createSealer({key:new Uint8Array(32).fill(93)})}),table=pgSchema(schema).table('customers',{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),[f]:local.text(f,{search:{exact:f==='company'?{bits:2}:true,substring:{wordBoundary:true}}})});
  const companion=local.register(table,{row:'id',scope:'scopeId'}),columns=Object.values(getTableColumns(companion)).map(c=>c.name).filter(n=>!['row_id','scope_id'].includes(n));
  for(const column of columns)assert(actualColumns.has(column));
  const groups={exact:columns.filter(c=>c.startsWith('eq_')),compact:columns.filter(c=>c.startsWith('pos_')),words:columns.filter(c=>c.startsWith('word_')),single:columns.filter(c=>c.startsWith('single_')),candidate:columns.filter(c=>c.startsWith('tokens_'))};
  for(const [stream,cols] of Object.entries(groups)){
   assert(cols.length>0,`${f} ${stream}: expected stored columns`);
   const expression=cols.map(c=>`coalesce(pg_column_size("${c}"),0)`).join('+');
   const bytes=Number((await pool.query(`select sum(${expression})::text bytes from ${schema}.customers_seal_index`)).rows[0].bytes);
   result.streams.push({field:f,stream,columns:cols,valueBytes:bytes,meanValueBytes:bytes/100000});
  }
 }
 const functions=(await pool.query("select p.proname,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname like 'sealql_%'",[schema])).rows;
 for(const statement of sealed.extraMigrationSql(h.seal).filter(s=>/create or replace function/i.test(s))){
  const name=statement.match(/function\s+(?:"[^"]+"\.)?"?([a-z_]+)"?\s*\(/i)?.[1],body=statement.match(/\$([a-z_]*)\$([\s\S]*)\$\1\$/i)?.[2]?.trim(),actual=functions.find((f:any)=>f.proname===name)?.definition.match(/\$([a-z_]*)\$([\s\S]*)\$\1\$/i)?.[2]?.trim();
  result.functionBodies.push({name,matches:body===actual});
 }
 assert(result.functionBodies.length>0&&result.functionBodies.every((f:any)=>f.name&&f.matches),'Installed function bodies match the final public migration');
 const companionCatalog=result.catalog.find((r:any)=>r.relation===schema+'.customers_seal_index');
 for(const statement of sealed.extraMigrationSql(h.seal)){
  const storage=statement.match(/alter column "([^"]+)" set storage main/i);
  if(storage)assert.equal(companionCatalog.columns.find((c:any)=>c.attname===storage[1])?.attstorage,'m',`${storage[1]} MAIN storage`);
 }
 result.provenance='Public schema builder + generated Drizzle migration + extraMigrationSql; source original plaintext loaded through sealed.insert';
 result.logicalSizeCaveat='SUM(pg_column_size(column)) is per-value stored/compressed size, excluding tuple/page/TOAST/index overhead; stream allocation is an estimate and must not be summed with table totals';
 result.complete=true;save('capacity',result);console.log(JSON.stringify({tables:result.tables,functionBodies:result.functionBodies}));
}finally{await pool.end();release();}
