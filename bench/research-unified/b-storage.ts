/** B-only mutations. The caller must verify the disposable cluster and own measure.lock. */
import assert from 'node:assert/strict';
import {encode} from './b-codec.js';
import {writeTokens} from './b-product.js';
export const customerFields=['name','phone','address','memo','email','company'] as const;
export const bFields=(table:'customers'|'tickets'):readonly string[]=>table==='customers'?customerFields:['memo'];
export const assertSchema=(schema:string)=>assert(/^research_u(?:_[a-z0-9_]+)?$/.test(schema),'B writes only to the agreed research_u schema');
export async function createTags(client:any,schema:string,table:'customers'|'tickets') {
  assertSchema(schema);
  await client.query(`CREATE TABLE ${schema}.b_${table}_tags(id uuid PRIMARY KEY,scope_id uuid NOT NULL,${bFields(table).flatMap(f=>[`ce_${f} bigint[] NOT NULL`,`cs_${f} bigint[] NOT NULL`,`salt_${f} bytea NOT NULL`,`jt_${f} bigint[] NOT NULL`,`jx_${f} bigint NOT NULL`]).join(',')})`);
}
function targetTable(table:'customers'|'tickets',target?:string){assert(!target||target==='b_w_tags');return target??`b_${table}_tags`;}
export async function insertTags(client:any,schema:string,table:'customers'|'tickets',rows:any[],target?:string) {
  assertSchema(schema);
  const batchKeys=new Map<string,Buffer>();
  const values=[];
  for(const r of rows){const row:any={id:r.id,scope_id:r.scope_id};for(const f of bFields(table)){
    const value=r[`${f}_norm`]??r[`${f}_plain`]??r[f];
    const tokens=r[`ce_${f}`]&&r[`cs_${f}`]?{ce:r[`ce_${f}`],cs:r[`cs_${f}`]}:await writeTokens(table,f,value);
    row[f]={...encode(table,f,value,batchKeys),...tokens};
  }values.push(row);}
  await client.query(`INSERT INTO ${schema}.${targetTable(table,target)} SELECT (x->>'id')::uuid,(x->>'scope_id')::uuid,${bFields(table).flatMap(f=>[`ARRAY(SELECT jsonb_array_elements_text(x->'${f}'->'ce')::bigint)`,`ARRAY(SELECT jsonb_array_elements_text(x->'${f}'->'cs')::bigint)`,`decode(x->'${f}'->>'salt','hex')`,`ARRAY(SELECT jsonb_array_elements_text(x->'${f}'->'jt')::bigint)`,`(x->'${f}'->>'jx')::bigint`]).join(',')} FROM jsonb_array_elements($1::jsonb) x`,[JSON.stringify(values,(_,v)=>typeof v==='bigint'?v.toString():v)]);
}
export async function updateTag(client:any,schema:string,table:'customers'|'tickets',id:string,field:string,value:string,target?:string) {
  assertSchema(schema);assert(bFields(table).includes(field));
  const v=encode(table,field,value);
  const tokens=await writeTokens(table,field,value);
  const result=await client.query(`UPDATE ${schema}.${targetTable(table,target)} SET salt_${field}=decode($1,'hex'),jt_${field}=$2::bigint[],jx_${field}=$3::bigint,ce_${field}=$5::bigint[],cs_${field}=$6::bigint[] WHERE id=$4`,[v.salt,v.jt,v.jx,id,tokens.ce,tokens.cs]);
  assert.equal(result.rowCount,1,'missing B tag row');
}
export async function indexTags(client:any,schema:string,table:'customers'|'tickets'){
  assertSchema(schema);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS b_${table}_scope_row ON ${schema}.b_${table}_tags(scope_id,id)`);
  for(const field of bFields(table))await client.query(`CREATE INDEX IF NOT EXISTS b_${table}_${field}_exact ON ${schema}.b_${table}_tags(scope_id,(ce_${field}[1]),id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS b_${table}_gin ON ${schema}.b_${table}_tags USING gin(${bFields(table).map(f=>`cs_${f}`).join(',')})`);
  await client.query(`ANALYZE ${schema}.b_${table}_tags`);
}
export async function deleteTags(client:any,schema:string,table:'customers'|'tickets',ids:string[],target?:string) {
  assertSchema(schema);
  await client.query(`DELETE FROM ${schema}.${targetTable(table,target)} WHERE id=ANY($1::uuid[])`,[ids]);
}
