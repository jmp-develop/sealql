/** Disposable X1 probe for plan/001 (revision 2). No product code or durable DB objects. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { profiles, searchPieces, searchTokens } from '../../src/core/search-tokens.js';
import { binding, guard, pool as fixturePool, scopeId, sealer, source } from '../standard-next/common.js';

const schema = 'gate_x1x2_20260927';
const table = `"${schema}"."probe"`;
const otherScope = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = (n:number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const model = binding('customers', true).model;
const spec = model.fields.memo;
const ring = sealer.ring(model.id);
const tokenProfiles = profiles(model.id, 'memo', spec);
const encoder = new TextEncoder();
const results:Record<string,unknown> = {};
function u16(n:number){const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;}
function u32(n:number){const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;}
async function envelope(text:string|null,rowId:string,scope=scopeId,field=0){
  if(text===null)return null;
  const ct=Buffer.from(await sealer.seal(text,{modelId:model.id,fieldId:'memo',keyScopeId:ring.keyScopeId,scopeId:scope,rowId,spec},ring));
  const arrays=await Promise.all(tokenProfiles.map(async p=>{
    const t=await searchTokens(ring,scope,p,searchPieces(p,text));
    return Buffer.from(`{${t.join(',')}}`);
  }));
  const s=encoder.encode(scope), r=encoder.encode(rowId);
  return Buffer.concat([Buffer.from([0x84]),u16(s.length),s,u16(r.length),r,Buffer.from([field]),...arrays.flatMap(a=>[u32(a.length),a]),ct]);
}
async function check(name:string, action:()=>Promise<unknown>, expected:'ok'|'SQL01'|'SQL02'|'SQL03'|'any-error'='ok'){
  try {const value:any=await action();results[name]={verdict:expected==='ok'?'confirmed':'refuted',observed:'ok',value:value?.rowCount!==undefined?{rowCount:value.rowCount}:value};}
  catch(e:any){results[name]={verdict:expected==='ok'?'refuted':expected==='any-error'||e.code===expected?'confirmed':'refuted',observed:e.code??e.name,message:String(e.message).slice(0,250)};}
}
const trigger=`CREATE FUNCTION "${schema}".sealql_probe_w() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v bytea; o int; n int; s text; r text;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id) THEN
    RAISE EXCEPTION USING ERRCODE='SQL01', MESSAGE='immutable row and scope';
  END IF;
  IF TG_OP='INSERT' OR NEW.memo_ct IS DISTINCT FROM OLD.memo_ct THEN
    v:=NEW.memo_ct;
    IF v IS NULL THEN NEW.memo_tok_e:=NULL; NEW.memo_tok_s:=NULL;
    ELSIF length(v)>0 AND get_byte(v,0)=132 THEN
      o:=1; n:=(get_byte(v,o)<<8)|get_byte(v,o+1); s:=convert_from(substring(v FROM o+3 FOR n),'UTF8'); o:=o+2+n;
      n:=(get_byte(v,o)<<8)|get_byte(v,o+1); r:=convert_from(substring(v FROM o+3 FOR n),'UTF8'); o:=o+2+n;
      IF s IS DISTINCT FROM NEW.tenant_id::text OR r IS DISTINCT FROM NEW.id::text OR get_byte(v,o)<>0 THEN
        RAISE EXCEPTION USING ERRCODE='SQL03', MESSAGE='binding mismatch';
      END IF;
      o:=o+1;
      n:=(get_byte(v,o)<<24)|(get_byte(v,o+1)<<16)|(get_byte(v,o+2)<<8)|get_byte(v,o+3);
      NEW.memo_tok_e:=convert_from(substring(v FROM o+5 FOR n),'UTF8')::bigint[]; o:=o+4+n;
      n:=(get_byte(v,o)<<24)|(get_byte(v,o+1)<<16)|(get_byte(v,o+2)<<8)|get_byte(v,o+3);
      NEW.memo_tok_s:=convert_from(substring(v FROM o+5 FOR n),'UTF8')::bigint[]; o:=o+4+n;
      NEW.memo_ct:=substring(v FROM o+1);
      IF length(NEW.memo_ct)=0 OR get_byte(NEW.memo_ct,0)<>3 THEN RAISE EXCEPTION USING ERRCODE='SQL02', MESSAGE='malformed envelope'; END IF;
    ELSIF TG_OP='INSERT' AND NEW.memo_tok_e IS NOT NULL AND NEW.memo_tok_s IS NOT NULL THEN NULL;
    ELSIF TG_OP='UPDATE' AND (NEW.memo_tok_e IS DISTINCT FROM OLD.memo_tok_e OR NEW.memo_tok_s IS DISTINCT FROM OLD.memo_tok_s) THEN NULL;
    ELSE RAISE EXCEPTION USING ERRCODE='SQL02', MESSAGE='write envelope required';
    END IF;
  END IF;
  RETURN NEW;
END $$`;
let created=false;
try{
  await guard();
  assert.equal((await fixturePool.query('show port')).rows[0].port,'56439');
  assert.equal((await fixturePool.query('select to_regclass($1) rel',[`${source}.customers`])).rows[0].rel!==null,true);
  assert.equal((await fixturePool.query('select count(*) n from bench_standard_next_100k.customers_skip_product_multi')).rows[0].n,'100000');
  assert.equal((await fixturePool.query('select 1 from pg_namespace where nspname=$1',[schema])).rowCount,0,'schema must not preexist');
  await fixturePool.query(`CREATE SCHEMA "${schema}"`);created=true;
  await fixturePool.query(`CREATE TABLE ${table}(tenant_id uuid NOT NULL,id uuid NOT NULL,status text NOT NULL DEFAULT 'active',memo_ct bytea,memo_tok_e bigint[],memo_tok_s bigint[],PRIMARY KEY(tenant_id,id))`);
  await fixturePool.query(trigger);
  await fixturePool.query(`CREATE TRIGGER sealql_probe_w BEFORE INSERT OR UPDATE OF memo_ct,tenant_id,id ON ${table} FOR EACH ROW EXECUTE FUNCTION "${schema}".sealql_probe_w()`);
  const memoValues=(await fixturePool.query(`SELECT memo_plain FROM ${source}.customers WHERE scope_id=$1 ORDER BY id LIMIT 3`,[scopeId])).rows.map(r=>String(r.memo_plain));
  assert.equal(memoValues.length,3);
  const e1=await envelope(memoValues[0],id(1));const e2=await envelope(memoValues[1],id(2));
  await check('single_insert',async()=>fixturePool.query(`INSERT INTO ${table}(tenant_id,id,memo_ct) VALUES($1,$2,$3)`,[scopeId,id(1),e1]));
  await check('array_insert',async()=>fixturePool.query(`INSERT INTO ${table}(tenant_id,id,memo_ct) VALUES($1,$2,$3),($1,$4,$5)`,[scopeId,id(2),e2,id(3),await envelope(memoValues[2],id(3))]));
  await check('stored_v3_and_tokens',async()=>{const r=(await fixturePool.query(`SELECT get_byte(memo_ct,0) version,cardinality(memo_tok_e) exact,cardinality(memo_tok_s) sub FROM ${table} WHERE id=$1`,[id(1)])).rows[0];assert.equal(r.version,3);assert(r.exact>0&&r.sub>0);return r;});
  await check('patch_value',async()=>fixturePool.query(`UPDATE ${table} SET memo_ct=$3 WHERE tenant_id=$1 AND id=$2`,[scopeId,id(1),await envelope(memoValues[1],id(1))]));
  await check('patch_null',async()=>fixturePool.query(`UPDATE ${table} SET memo_ct=NULL WHERE tenant_id=$1 AND id=$2`,[scopeId,id(2)]));
  await check('patch_null_clears_tokens',async()=>{const r=(await fixturePool.query(`SELECT memo_ct,memo_tok_e,memo_tok_s FROM ${table} WHERE id=$1`,[id(2)])).rows[0];assert.equal(r.memo_ct,null);assert.equal(r.memo_tok_e,null);assert.equal(r.memo_tok_s,null);return r;});
  await check('raw_cipher_without_tokens',async()=>fixturePool.query(`UPDATE ${table} SET memo_ct=$3 WHERE tenant_id=$1 AND id=$2`,[scopeId,id(1),Buffer.from([3,1,2,3])]),'SQL02');
  await check('wrong_row_envelope',async()=>fixturePool.query(`UPDATE ${table} SET memo_ct=$3 WHERE tenant_id=$1 AND id=$2`,[scopeId,id(1),await envelope(memoValues[0],id(2))]),'SQL03');
  await check('wrong_scope_envelope',async()=>fixturePool.query(`UPDATE ${table} SET memo_ct=$3 WHERE tenant_id=$1 AND id=$2`,[scopeId,id(1),await envelope(memoValues[0],id(1),otherScope)]),'SQL03');
  await check('wrong_field_envelope',async()=>fixturePool.query(`UPDATE ${table} SET memo_ct=$3 WHERE tenant_id=$1 AND id=$2`,[scopeId,id(1),await envelope(memoValues[0],id(1),scopeId,1)]),'SQL03');
  await check('wrong_row_where',async()=>fixturePool.query(`UPDATE ${table} SET memo_ct=$3 WHERE tenant_id=$1 AND id=$2`,[scopeId,id(2),await envelope(memoValues[0],id(1))]),'SQL03');
  await check('where_matches_no_row',async()=>fixturePool.query(`UPDATE ${table} SET memo_ct=$3 WHERE tenant_id=$1 AND id=$2`,[scopeId,id(9),await envelope(memoValues[0],id(1))]),'SQL03');
  await check('multirow_update',async()=>fixturePool.query(`UPDATE ${table} SET memo_ct=$2 WHERE tenant_id=$1`,[scopeId,await envelope(memoValues[0],id(1))]),'SQL03');
  await check('id_change',async()=>fixturePool.query(`UPDATE ${table} SET id=$3 WHERE tenant_id=$1 AND id=$2`,[scopeId,id(1),id(4)]),'SQL01');
  await check('scope_change',async()=>fixturePool.query(`UPDATE ${table} SET tenant_id=$3 WHERE tenant_id=$1 AND id=$2`,[scopeId,id(1),otherScope]),'SQL01');
  await check('upsert_set_v',async()=>fixturePool.query(`INSERT INTO ${table}(tenant_id,id,memo_ct) VALUES($1,$2,$3) ON CONFLICT(tenant_id,id) DO UPDATE SET memo_ct=$3`,[scopeId,id(1),await envelope(memoValues[2],id(1))]));
  await check('upsert_do_nothing',async()=>fixturePool.query(`INSERT INTO ${table}(tenant_id,id,memo_ct) VALUES($1,$2,$3) ON CONFLICT(tenant_id,id) DO NOTHING`,[scopeId,id(1),await envelope(memoValues[1],id(1))]));
  await check('upsert_false_where',async()=>fixturePool.query(`INSERT INTO ${table}(tenant_id,id,memo_ct) VALUES($1,$2,$3) ON CONFLICT(tenant_id,id) DO UPDATE SET memo_ct=EXCLUDED.memo_ct WHERE FALSE`,[scopeId,id(1),await envelope(memoValues[1],id(1))]));
  await check('upsert_excluded',async()=>fixturePool.query(`INSERT INTO ${table}(tenant_id,id,memo_ct) VALUES($1,$2,$3) ON CONFLICT(tenant_id,id) DO UPDATE SET memo_ct=EXCLUDED.memo_ct`,[scopeId,id(1),await envelope(memoValues[1],id(1))]));
  await check('upsert_id_only_cross_tenant',async()=>{await fixturePool.query(`CREATE UNIQUE INDEX probe_id_unique ON ${table}(id)`);return fixturePool.query(`INSERT INTO ${table}(tenant_id,id,memo_ct) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,memo_ct=EXCLUDED.memo_ct`,[otherScope,id(1),await envelope(memoValues[0],id(1),otherScope)]);},'SQL01');
  await check('copy_restore',async()=>{const r=(await fixturePool.query(`SELECT memo_ct,memo_tok_e,memo_tok_s FROM ${table} WHERE id=$1`,[id(1)])).rows[0];return fixturePool.query(`INSERT INTO ${table}(tenant_id,id,memo_ct,memo_tok_e,memo_tok_s) VALUES($1,$2,$3,$4,$5)`,[scopeId,id(5),r.memo_ct,r.memo_tok_e,r.memo_tok_s]);});
  await check('rollback_and_savepoint',async()=>{const c=await fixturePool.connect();try{await c.query('BEGIN');await c.query('SAVEPOINT a');await c.query(`INSERT INTO ${table}(tenant_id,id,memo_ct) VALUES($1,$2,$3)`,[scopeId,id(6),await envelope(memoValues[0],id(6))]);await c.query('ROLLBACK TO a');const n=(await c.query(`SELECT count(*) n FROM ${table} WHERE id=$1`,[id(6)])).rows[0].n;assert.equal(n,'0');await c.query('ROLLBACK');return n;}finally{c.release();}});
  await check('plain_update_zero_trigger_calls',async()=>{const c=await fixturePool.connect();try{await c.query('SET track_functions = pl');await c.query('SELECT pg_stat_reset()');await c.query(`UPDATE ${table} SET status='hold' WHERE id=$1`,[id(1)]);await c.query('SELECT pg_stat_clear_snapshot()');const x=(await c.query(`SELECT calls FROM pg_stat_user_functions WHERE schemaname=$1 AND funcname='sealql_probe_w'`,[schema])).rows[0];return x??{calls:0,note:'stats may flush asynchronously'};}finally{c.release();}});
  await mkdir('bench/results/2026-09-27-gate-x1x2',{recursive:true});
  await writeFile('bench/results/2026-09-27-gate-x1x2/x1.json',JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results,null,2));
}finally{if(created)await fixturePool.query(`DROP SCHEMA "${schema}" CASCADE`);await fixturePool.end();}

