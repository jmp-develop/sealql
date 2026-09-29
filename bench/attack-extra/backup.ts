import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from '../../src/index.js';
import {createSealed,registrationOf} from '../../src/adapters/drizzle/v0.45/native.js';
import {Codec,norm,positions,type Snapshot} from './codec.js';
import {assert,connect,fields,loadRows,save,scope} from './common.js';
const schema='test_attack_extra_snapshots';
const sealer=createSealer({key:new Uint8Array(32).fill(93)}),sealed=createSealed({sealer});
const table=pgSchema(schema).table('customers',{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),...Object.fromEntries(fields.map(f=>[f,sealed.text(f,{search:{exact:f==='company'?{bits:2}:true,substring:true}})]))});
const seal=sealed.register(table,{row:'id',scope:'scopeId'}),profiles=registrationOf(seal).storage.index!.profiles!;
const source=(await loadRows()).slice(0,256),initial=source.slice(0,128),db=await connect(),orm=drizzle(db);
let created=false;
const result:any={schema,rows:128,complete:false,source:'fixture-derived raw plaintext',cases:[],rawPhysicalWalParsed:false};
const read=async()=>({parent:(await db.query(`select * from ${schema}.customers order by id`)).rows,index:(await db.query(`select * from ${schema}.customers_seal_index order by row_id`)).rows});
const delta=(a:string[],b:string[])=>b.filter(x=>!new Set(a).has(x));
function mapping(codec:Codec,values:string[]){const ts=new Map<string,number[]>(),ps=new Map<string,number[]>();values.forEach((v,i)=>{for(const t of codec.tokens(v)){const s=ts.get(t)??[];s.push(i);ts.set(t,s);}for(const p of codec.pieces(v)){const s=ps.get(p)??[];s.push(i);ps.set(p,s);}});const reverse=new Map<string,string[]>();for(const [piece,ids]of ps){const key=ids.join(','),a=reverse.get(key)??[];a.push(piece);reverse.set(key,a);}const out=new Map<string,string>();for(const [token,ids]of ts){const matches=reverse.get(ids.join(','));if(matches?.length===1)out.set(token,matches[0]);}return out;}
try{
 assert.equal((await db.query('select to_regnamespace($1) n',[schema])).rows[0].n,null);await db.query(`create schema ${schema}`);created=true;
 for(const statement of await generateMigration(generateDrizzleJson({}),generateDrizzleJson({table,seal})))await db.query(statement);
 for(const statement of sealed.extraMigrationSql(seal))await db.query(statement);
 await sealed.insert(orm,seal,initial.map(r=>({...r,scopeId:scope})));
 const codecs=Object.fromEntries(fields.map(f=>[f,new Codec(f)]));let before=await read();
 // Verify actual PostgreSQL bytea/bigint[] against the independent synchronous codec.
 for(const row of before.index){const original=initial.find(r=>r.id===row.row_id)!;for(const field of fields){const p=profiles[field+'/substring'];const group=p.positions!;const fast=codecs[field].snapshot(original[field],row[group.salt]);assert.deepEqual(fast.stamps.map(String),row[group.stamps]);assert.deepEqual(fast.offsets,row[group.offsets]);assert.deepEqual(fast.tokens,row[p.tokens]);}}
 const truth=new Map(initial.map(r=>[r.id,{...r}]));
 for(const scenario of ['same-memo','changed-memo','changed-email']){
  const changedField=scenario==='changed-email'?'email':'memo',codec=codecs[changedField],p=profiles[changedField+'/substring'],g=p.positions!;
  const labelMap=mapping(codec,initial.map(r=>r[changedField]));const observedPiece=Array.from(norm(initial[0][changedField])).slice(0,2).join(''),observedKey=codec.key(observedPiece);
  for(let i=0;i<64;i++){const row=initial[i],value=scenario==='same-memo'?row.memo:source[128+i][changedField];await sealed.update(orm,seal,{id:row.id,scopeId:scope},{[changedField]:value});truth.get(row.id)![changedField]=value;}
  const after=await read(),metrics={scenario,updated:64,saltsChanged:0,exactSaltsChanged:0,exactStampsChanged:0,ciphertextsChanged:0,unchangedFieldCells:0,checkedUnchangedFieldCells:0,stampIntersection:0,tokensUnchanged:0,addedTokens:0,removedTokens:0,changedPieces:0,guessedPieces:0,correctChangedPieces:0,observedKeyPositionsBefore:0,observedKeyPositionsAfter:0,randomPieceExpectedCorrect:0};
  for(const row of after.index){const old=before.index.find(r=>r.row_id===row.row_id)!,changed=initial.slice(0,64).some(r=>r.id===row.row_id);if(!changed){assert.deepEqual(row,old);continue;}
   metrics.saltsChanged+=Number(!row[g.salt].equals(old[g.salt]));metrics.stampIntersection+=row[g.stamps].filter((s:string)=>old[g.stamps].includes(s)).length;const exact=profiles[changedField+'/exact'].exact!;metrics.exactSaltsChanged+=Number(!row[exact.salt].equals(old[exact.salt]));metrics.exactStampsChanged+=Number(row[exact.stamp]!==old[exact.stamp]);
   const oldBody=before.parent.find(r=>r.id===row.row_id)!,newBody=after.parent.find(r=>r.id===row.row_id)!;metrics.ciphertextsChanged+=Number(!newBody[changedField+'_ct'].equals(oldBody[changedField+'_ct']));
   for(const field of fields.filter(f=>f!==changedField)){for(const pr of Object.entries(profiles).filter(([id])=>id.startsWith(field+'/')).map(([,p])=>p)){for(const column of [pr.tokens,...Object.values(pr.positions??{}),...Object.values(pr.exact??{})]){metrics.checkedUnchangedFieldCells++;assert.deepEqual(row[column],old[column]);metrics.unchangedFieldCells++;}}}
   const added=delta(old[p.tokens],row[p.tokens]),removed=delta(row[p.tokens],old[p.tokens]);metrics.addedTokens+=added.length;metrics.removedTokens+=removed.length;metrics.tokensUnchanged+=Number(!added.length&&!removed.length);
   const oldValue=scenario==='changed-email'?initial.find(r=>r.id===row.row_id)!.email:initial.find(r=>r.id===row.row_id)!.memo;
   const oldPieces=codec.pieces(oldValue),newPieces=codec.pieces(truth.get(row.row_id)![changedField]),trueAdded=new Set(delta(oldPieces,newPieces)),trueRemoved=new Set(delta(newPieces,oldPieces));metrics.changedPieces+=trueAdded.size+trueRemoved.size;
   const vocab=new Set(initial.flatMap(r=>codec.pieces(r[changedField]))).size;
   for(const [tokens,expected]of [[added,trueAdded],[removed,trueRemoved]] as [string[],Set<string>][])for(const t of tokens){const guess=labelMap.get(t);if(guess){metrics.guessedPieces++;metrics.correctChangedPieces+=Number(expected.has(guess));metrics.randomPieceExpectedCorrect+=expected.size/vocab;}}
   const snap=(r:any):Snapshot=>({salt:r[g.salt],n:r[g.length],stamps:r[g.stamps].map(BigInt),offsets:r[g.offsets],tokens:r[p.tokens]});
   metrics.observedKeyPositionsBefore+=positions(snap(old),observedKey).length;metrics.observedKeyPositionsAfter+=positions(snap(row),observedKey).length;
  }
  assert.equal(metrics.saltsChanged,64);assert.equal(metrics.exactSaltsChanged,64);assert.equal(metrics.exactStampsChanged,64);assert.equal(metrics.ciphertextsChanged,64);assert.equal(metrics.stampIntersection,0);if(scenario==='same-memo')assert.equal(metrics.tokensUnchanged,64);
  result.cases.push(metrics);before=after;
 }
 const opened=await sealed.open(await orm.select().from(table));for(const row of opened)for(const field of fields)assert.equal((row as any)[field],truth.get(row.id)![field]);
 result.roundtripFields=opened.length*fields.length;result.codecDatabaseChecks=128*fields.length;result.complete=true;
}finally{if(created){await db.query(`drop schema ${schema} cascade`);result.schemaDeleted=(await db.query('select to_regnamespace($1) n',[schema])).rows[0].n===null;}await db.end();save('backup',result);}
console.log(JSON.stringify(result,null,2));
