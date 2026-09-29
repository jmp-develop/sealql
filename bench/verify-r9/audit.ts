import {getTableColumns} from 'drizzle-orm';
import {getTableConfig} from 'drizzle-orm/pg-core';
import {generateDrizzleJson} from 'drizzle-kit/api';
import {createHash} from 'node:crypto';
import {acquire,release,connect,model,save,fields,sealed,scope,assert} from './common.js';

const names=['test_r9_performance','test_r9_performance_main'];
const expected=model('test_r9_performance_main');
if(process.argv.includes('--offline')){
 const extra=sealed.extraMigrationSql(expected.seal);save('expected',{columns:Object.values(getTableColumns(expected.seal)).map(c=>({name:c.name,type:c.getSQLType(),notNull:c.notNull})),snapshot:generateDrizzleJson(expected),extra});console.log(extra[0]?.slice(0,1800));
}else{
 acquire();const pool=await connect();
 try{
  const result:any={at:new Date().toISOString(),session:(await pool.query("select pg_backend_pid() pid,version(),current_setting('work_mem') work_mem,current_setting('max_parallel_workers_per_gather') parallel_workers,(select datcollate from pg_database where datname=current_database()) locale")).rows[0],schemas:[]};
  for(const schema of names){
   if(!(await pool.query('select to_regnamespace($1) n',[schema])).rows[0].n)continue;
   const tables=[];for(const table of ['customers','customers_seal_index']){
    const relation=`${schema}.${table}`,count=(await pool.query(`select count(*)::int n,count(distinct ${table==='customers'?'id':'row_id'})::int ids,count(distinct scope_id)::int scopes from ${relation}`)).rows[0];
    const columns=(await pool.query("select attname,format_type(atttypid,atttypmod) type,attnotnull,attstorage,attstattarget from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped order by attnum",[relation])).rows;
    const indexes=(await pool.query('select indexname,indexdef from pg_indexes where schemaname=$1 and tablename=$2 order by indexname',[schema,table])).rows;
    const constraints=(await pool.query('select conname,pg_get_constraintdef(oid) definition from pg_constraint where conrelid=$1::regclass',[relation])).rows;
    tables.push({table,count,columns,indexes,constraints});
   }
   const functions=(await pool.query("select p.proname,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname like 'sealql_%' order by proname",[schema])).rows;
   const h=model(schema),extra=sealed.extraMigrationSql(h.seal),sqlFunctions=extra.filter(s=>/create or replace function/i.test(s));
   const bodies=sqlFunctions.map(s=>{const name=s.match(/function\s+(?:"[^"]+"\.)?"?([a-z_]+)"?\s*\(/i)?.[1];const body=s.match(/\$([a-z_]*)\$([\s\S]*)\$\1\$/i)?.[2]?.trim();const actual=functions.find((f:any)=>f.proname===name);const actualBody=actual?.definition.match(/\$([a-z_]*)\$([\s\S]*)\$\1\$/i)?.[2]?.trim();return {name,matches:body===actualBody,expectedSha256:createHash('sha256').update(body??'missing').digest('hex'),actualSha256:createHash('sha256').update(actualBody??'missing').digest('hex')};});
   const sample=await sealed.open(await (await import('drizzle-orm/node-postgres')).drizzle(pool).select().from(h.table).limit(20));
   const sampleIds=sample.map(r=>r.id),truth=(await pool.query(`select id,${fields.map(f=>`${f}_norm as ${f}`).join(',')} from research_u.customers_plain where id=any($1::uuid[])`,[sampleIds])).rows;
   for(const row of sample)for(const f of fields)assert.equal(row[f],truth.find(r=>r.id===row.id)[f]);
   const identity=(await pool.query(`select count(*)::int n from ((select id from ${schema}.customers except select id from research_u.customers_plain where scope_id=$1) union all (select id from research_u.customers_plain where scope_id=$1 except select id from ${schema}.customers)) s`,[scope])).rows[0].n;
   const correlations=(await pool.query("select tablename,attname,correlation from pg_stats where schemaname=$1 and attname in ('id','row_id')",[schema])).rows;
   result.schemas.push({schema,tables,functions:functions.map(f=>({name:f.proname,definition:f.definition})),functionBodies:bodies,identityMismatch:identity,samplePlainEquality:sample.length,correlations});
  }
  const plain=(await pool.query("select indexname,indexdef from pg_indexes where schemaname='research_u' and tablename='customers_plain' order by indexname")).rows;result.plainIndexes=plain;
  save('audit',result);console.log(JSON.stringify({session:result.session,schemas:result.schemas.map((s:any)=>({schema:s.schema,counts:s.tables.map((t:any)=>t.count),functionBodies:s.functionBodies,identityMismatch:s.identityMismatch,correlations:s.correlations}))}));
 }finally{await pool.end();release();}
}
