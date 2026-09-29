import type {Pool} from 'pg';
import type {Node} from './common.js';
import type {Statement} from './instrument.js';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {getTableColumns} from 'drizzle-orm';
import {createSealer} from '../../src/core/field-cipher.js';
import {createSealed} from '../../src/adapters/drizzle/v0.45/native.js';
import {prepareVariants as prepareSQL,researchFallback,functionVariant,storageVariant,exactTailVariant,type Query} from './variants.js';
import {fields,scope,assert,save,readFileSync,OUT} from './common.js';
import {existsSync} from 'node:fs';
import {productSchema,customersSeal} from './product.js';
export interface BenchmarkVariant {name:string;modes:string[];beforeCase?:(node:Node)=>Promise<void>;rewrite:(statement:Statement,context:{node:Node;mode:string})=>Statement;description:string;}
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
function metadata(schema:string){const cipher=createSealer({key:Buffer.alloc(32,93)}),sealed=createSealed({sealer:cipher}),table=pgSchema(schema).table('customers',{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),...Object.fromEntries(fields.map(f=>[f,sealed.text(f,{search:{exact:f==='company'?{bits:2}:true,substring:true}})]))}),seal=sealed.register(table,{row:'id',scope:'scopeId'});return {cipher,sealed,table,seal};}
export async function prepareVariants(pool:Pool):Promise<BenchmarkVariant[]>{
 const main=metadata(productSchema),allModes=['count','list300','listAll'];
 const physical=Object.values(getTableColumns(customersSeal)).map(c=>c.name).sort();assert.deepEqual(Object.values(getTableColumns(main.seal)).map(c=>c.name).sort(),physical,'src variant metadata matches public dist columns');
 let prepared:Awaited<ReturnType<typeof prepareSQL>>,preparedNode:Node;
 const beforeCase=async(node:Node)=>{if(preparedNode!==node){prepared=await prepareSQL(main.seal,main.cipher,scope,node);preparedNode=node;}};
 const convert=(q:Query):Statement=>({text:q.text,values:q.params}),from=(q:Statement):Query=>({text:q.text,params:q.values});
 const variants:BenchmarkVariant[]=[
  {name:'v4a_seal_count',modes:['count'],beforeCase,description:'Pure secure predicate counted in companion, no parent JOIN; standard API preparation retained',rewrite:()=>convert(prepared.count)},
  {name:'v4d_research_fallback',modes:['list300'],beforeCase,description:'Research candidate ordering then final proof then LIMIT; keeps quick prefix and API projection; unbounded queries have no bounded fallback to transform',rewrite:s=>convert(researchFallback(from(s),prepared.coarse))},
 ];
 const functions=[];for(const mode of ['checks-off','qualified-no-set'] as const){const variant=functionVariant(productSchema,mode);for(const sql of variant.statements)await pool.query(sql);functions.push({mode,removedChecks:variant.removedChecks});variants.push({name:mode==='checks-off'?'v4b_checks_off':'v4b_qualified_no_set',modes:allModes,description:mode,rewrite:s=>convert(variant.rewrite(from(s)))});}
 const relation=`${productSchema}.customers_seal_index`,indexDefs=(await pool.query('select indexname,indexdef from pg_indexes where schemaname=$1 and tablename=$2 order by indexname',[productSchema,'customers_seal_index'])).rows;
 for(const table of ['customers','customers_seal_index'])await pool.query(`vacuum analyze ${productSchema}.${table}`);
 const columns=(await pool.query('select attname,format_type(atttypid,atttypmod) type from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped order by attnum',[relation])).rows;
 const previous=existsSync(`${OUT}/variant-setup.json`)?JSON.parse(readFileSync(`${OUT}/variant-setup.json`,'utf8')):null;
 const commit=JSON.parse(readFileSync(`${OUT}/product-load.json`,'utf8')).commit;
 if(previous?.complete)assert.equal(previous.commit,commit,'Reuse only clones from this product build');
 const clones=[];
 for(const storage of ['MAIN','EXTENDED'] as const)for(const cover of [true,false]){
  const schema=`test_final_return_${storage.toLowerCase()}_${cover?'tail':'bare'}`,target=`${schema}.customers_seal_index`,clone=metadata(schema);
  if(previous?.complete){assert(previous.clones.some((c:any)=>c.schema===schema&&c.allValuesEqual));assert.equal((await pool.query(`select count(*)::int n from ${target}`)).rows[0].n,100000);clones.push(previous.clones.find((c:any)=>c.schema===schema));}
  else{
  assert.equal((await pool.query('select to_regnamespace($1) n',[schema])).rows[0].n,null,`${schema}: fresh owned clone only`);
  await pool.query(`create schema ${quote(schema)}`);
  await pool.query(`create table ${quote(schema)}.customers_seal_index (like ${quote(productSchema)}.customers_seal_index including defaults including storage including constraints)`);
  for(const sql of storageVariant(clone.seal,storage))await pool.query(sql);
  const selection=columns.map((c:any)=>c.type.endsWith('[]')?`${quote(c.attname)} || '{}'::${c.type}`:quote(c.attname)).join(',');
  await pool.query(`insert into ${quote(schema)}.customers_seal_index select ${selection} from ${quote(productSchema)}.customers_seal_index order by row_id`);
  const tails=exactTailVariant(clone.seal,cover),tailNames=new Set(tails.filter(s=>s.startsWith('create index')).map(s=>s.match(/^create index "([^"]+)"/)![1]));
  for(const index of indexDefs)if(!tailNames.has(index.indexname))await pool.query(index.indexdef.replaceAll(`${productSchema}.`,`${schema}.`).replaceAll(`${quote(productSchema)}.`,`${quote(schema)}.`));
  for(const sql of tails)await pool.query(sql);await pool.query(`analyze ${target}`);
  assert.equal((await pool.query(`select count(*)::int n from ${target}`)).rows[0].n,100000);
  const left=columns.map((c:any)=>'c.'+quote(c.attname)).join(','),right=columns.map((c:any)=>'p.'+quote(c.attname)).join(',');
  assert.equal((await pool.query(`select count(*)::int n from ${target} c join ${relation} p using(row_id,scope_id) where row(${left}) is distinct from row(${right})`)).rows[0].n,0,'Clone contains exactly the same proof/token values');
  const catalog=(await pool.query('select attname,attstorage from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped order by attnum',[target])).rows;
  const sizes=(await pool.query('select pg_relation_size($1)::text heap,pg_indexes_size($1)::text indexes,pg_total_relation_size($1)::text total',[target])).rows[0];
  clones.push({schema,storage,cover,rows:100000,allValuesEqual:true,catalog,sizes});save('variant-setup',{commit,functions,clones,complete:false});
  }
  variants.push({name:`v4c_${storage.toLowerCase()}_${cover?'tail':'bare'}`,modes:allModes,description:`Identical ordered fresh clone: storage ${storage}, exact tail ${cover}`,rewrite:s=>({...s,text:s.text.replaceAll(`"${productSchema}"."customers_seal_index"`,`"${schema}"."customers_seal_index"`)})});
 }
 save('variant-setup',{commit,functions,clones,complete:true,note:'4c factors compared among four sorted clones; product parent stays unchanged; explicit array concat detoasts before target storage'});
 return variants;
}
