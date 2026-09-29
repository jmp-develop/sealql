/** Stateful occurrence-index leakage models. This is NOT an SDK implementation.
 * C-port retains the historical occurrence-tag digest proxy in this file.
 * Encoder state is evaluator-only; attackers receive snapshot()/query() outputs.
 */
import {hash,createHmac,createCipheriv,createDecipheriv} from 'node:crypto';
import {norm,assert} from '../competitor-sim/models.js';
export {rows,fields,norm,rng,shuffled,assert} from '../competitor-sim/models.js';
export type ModelId='C-port'|'C-mongo';
export type Mode='combined'|'eq'|'partial';
export interface Options {id:ModelId;field:string;mode?:Mode;contention?:number;maxLength?:number}
export interface RowView {id:string;tags:string[];tagCount:number;cipherBytes:number;supported:boolean}
export interface EscView {id:string;n?:number;value?:string}
export interface Snapshot {model:ModelId;field:string;mode:Mode;rows:RowView[];esc:EscView[];metadata:Record<string,unknown>}
export interface QueryView {model:ModelId;field:string;op:'eq'|'contains';keys:string[];unsupported?:string}
const digest=(...xs:(string|Uint8Array)[])=>hash('sha256',Buffer.concat(xs.map(x=>typeof x==='string'?Buffer.from(x):Buffer.from(x))),'buffer');
const uint32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
export function publicPieces(field:string,value:string,mode:Mode='combined'){
 const v=norm(value),cs=Array.from(v),out=new Set<string>();
 if(mode!=='partial')out.add('e\0'+v);
 if(mode!=='eq'){
  for(let n=2;n<=10;n++)for(let i=0;i+n<=cs.length;i++)out.add('s\0'+cs.slice(i,i+n).join(''));
  if(mode==='combined'&&(field==='address'||field==='email'))for(let n=2;n<=Math.min(10,cs.length);n++){out.add('p\0'+cs.slice(0,n).join(''));out.add('x\0'+cs.slice(-n).join(''));}
 }
 return [...out];
}
export const portToken=(field:string,piece:string)=>digest(Buffer.alloc(32,7),'customers\0'+field+'\0'+piece);
export const portTag=(token:Uint8Array,n:number)=>digest(token,uint32(n)).subarray(0,8).toString('hex');
export const portEscId=(token:Uint8Array)=>digest(token,'esc').toString('hex');
export function publicRowShape(options:Options,value:string){
 const v=norm(value),mode=options.mode??(options.id==='C-port'?'combined':'partial');
 if(options.id==='C-port')return {tagCount:publicPieces(options.field,v,mode).length,cipherBytes:Buffer.byteLength(v)+28,supported:true};
 const E=16*Math.floor((Buffer.byteLength(v)+5+16)/16),maxLength=options.maxLength??60,P=Math.min(maxLength,E-5);
 let M=0;for(let j=2;j<=Math.min(10,P);j++)M+=P-j+1;
 return {tagCount:mode==='eq'?1:1+M,cipherBytes:E,supported:mode==='eq'||Array.from(v).length<=maxLength};
}
const hmac=(key:Uint8Array,...parts:(string|Uint8Array)[])=>createHmac('sha256',key).update(Buffer.concat(parts.map(x=>typeof x==='string'?Buffer.from(x):Buffer.from(x)))).digest();
const uint64=(n:number)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const mongoKeys=(field:string,piece:string,u:number)=>{const root=hmac(Buffer.alloc(32,93),'mongo-reeval/field/'+field),value=hmac(root,piece,uint64(u));return [hmac(value,'EDC'),hmac(value,'ESC-id'),hmac(value,'ESC-value')];};
const mongoTag=(key:Uint8Array,n:number)=>hmac(key,uint64(n)).toString('hex');
const mongoEsc=(key:Uint8Array,n:number)=>hmac(key,n===0?'anchor':uint64(n)).toString('hex');
const sealedCount=(key:Uint8Array,n:number,serial:number,domain='record')=>{const iv=hmac(key,'iv/'+domain,uint64(serial)).subarray(0,16),c=createCipheriv('aes-256-ctr',key,iv);return Buffer.concat([iv,c.update(uint64(n)),c.final()]).toString('hex');};
const openedCount=(key:Uint8Array,value:string)=>{const b=Buffer.from(value,'hex'),c=createDecipheriv('aes-256-ctr',key,b.subarray(0,16));return Number(Buffer.concat([c.update(b.subarray(16)),c.final()]).readBigUInt64LE());};
const escMaps=new WeakMap<Snapshot,Map<string,EscView>>();
/** Derives only from an observed query value token, never a root key. */
export function queryTags(query:QueryView,snapshot:Snapshot):string[]{
 assert.equal(query.model,snapshot.model);if(query.unsupported)return [];
 if(query.model==='C-port'){const key=Buffer.from(query.keys[0],'hex'),entry=snapshot.esc.find(e=>e.id===portEscId(key));return Array.from({length:entry?.n??0},(_,i)=>portTag(key,i+1));}
 let index=escMaps.get(snapshot);if(!index){index=new Map(snapshot.esc.map(e=>[e.id,e]));escMaps.set(snapshot,index);}
 const tags:string[]=[];
 for(let i=0;i<query.keys.length;i+=3){const [edc,esc,enc]=query.keys.slice(i,i+3).map(k=>Buffer.from(k,'hex'));let n=0;
  const anchor=index.get(mongoEsc(esc,0));if(anchor)n=openedCount(enc,anchor.value!);
  else {let lo=0,hi=1;while(index.has(mongoEsc(esc,hi))){lo=hi;hi*=2;}while(lo+1<hi){const mid=Math.floor((lo+hi)/2);if(index.has(mongoEsc(esc,mid)))lo=mid;else hi=mid;}n=lo;
   if(n)assert.equal(openedCount(enc,index.get(mongoEsc(esc,n))!.value!),n);
  }
  for(let j=1;j<=n;j++)tags.push(mongoTag(edc,j));
 }return tags;
}
const tagMaps=new WeakMap<Snapshot,Map<string,number|number[]>>();
export function queryHits(query:QueryView,snapshot:Snapshot):number[]{
 let index=tagMaps.get(snapshot);if(!index){index=new Map();snapshot.rows.forEach((r,i)=>{if(!r.supported)return;for(const t of r.tags){const prior=index!.get(t);if(prior===undefined)index!.set(t,i);else if(typeof prior==='number')index!.set(t,[prior,i]);else prior.push(i);}});tagMaps.set(snapshot,index);}
 const hits=new Set<number>();for(const t of queryTags(query,snapshot)){const r=index.get(t);if(r!==undefined)for(const i of typeof r==='number'?[r]:r)hits.add(i);}return [...hits].sort((a,b)=>a-b);
}
export function createOccurrenceModel(options:Options){
 if(options.id==='C-mongo')return createMongoModel(options);
 const mode=options.mode??'combined',field=options.field,counters=new Map<string,{key:Buffer;n:number}>(),views:RowView[]=[];
 const encoder={id:options.id,field,mode,metadata:{source:'historical occurrence-tag proxy retained in bench/mongo-reeval/models.ts',tagBits:64,counter:'plaintext per piece',mode,contention:0,logicalUnorderedTagSets:true},
  pieces:(v:string)=>publicPieces(field,v,mode),
  insert(id:string,value:string){assert.ok(!views.some(r=>r.id===id));const tags=encoder.pieces(value).map(p=>{let e=counters.get(p);if(!e){e={key:portToken(field,p),n:0};counters.set(p,e);}return portTag(e.key,++e.n);}).sort();
   const row:RowView={id,tags,tagCount:tags.length,cipherBytes:Buffer.byteLength(norm(value))+28,supported:true};views.push(row);return row;},
  remove(id:string){const i=views.findIndex(r=>r.id===id);assert.ok(i>=0);views.splice(i,1);},
  update(id:string,value:string){encoder.remove(id);return encoder.insert(id,value);},
  snapshot(_compacted=false):Snapshot{return {model:options.id,field,mode,rows:views.map(r=>({...r,tags:[...r.tags]})),esc:[...counters.values()].map(e=>({id:portEscId(e.key),n:e.n})).sort((a,b)=>a.id.localeCompare(b.id)),metadata:{...encoder.metadata,compacted:false,escRows:counters.size}};},
  query(value:string,op:'eq'|'contains'='contains'):QueryView{const v=norm(value),n=Array.from(v).length;
   const unsupported=op==='eq'&&mode==='partial'?'equality profile disabled':op==='contains'&&mode==='eq'?'substring profile disabled':op==='contains'&&(n<2||n>10)?'substring query length outside 2..10':undefined;
   return {model:options.id,field,op,keys:unsupported?[]:[portToken(field,(op==='eq'?'e':'s')+'\0'+v).toString('hex')],...(unsupported?{unsupported}:{})};}
 };return encoder;
}
function createMongoModel(options:Options){
 const mode=options.mode??'partial',field=options.field,cf=options.contention??8;assert.ok(mode!=='combined','Mongo query profiles must be separate');
 const views=new Map<string,RowView>(),records:EscView[]=[],groups=new Map<string,{keys:Buffer[];n:number}>();let serial=0;
 const encoder={id:options.id,field,mode,metadata:{source:'Mongo official padding/ESC review: v-astra/model-rules-ko.md',tagBits:256,contention:cf,mode,maxLength:options.maxLength??60,
  fidelity:'Leakage model, independent field/value keys and AES-CTR counter envelope; NOT SDK bytes. Post-compaction endpoint replaces each hidden group by one encrypted anchor; runtime cleanup transcript is not reproduced.',cipherBytes:'Only observable encrypted BSON length bucket E; constant envelope overhead omitted',logicalUnorderedTagSets:true},
  pieces(value:string){const v=norm(value),real=publicPieces(field,v,mode),shape=publicRowShape(options,v);if(mode==='eq'||!shape.supported)return real;
   // Source includes one exact tag inside substring payload, without enabling equality queries.
   return ['e\0'+v,...real,...Array(Math.max(0,shape.tagCount-real.length-1)).fill('pad\0'+v)];},
  insert(id:string,value:string){assert.ok(!views.has(id));const shape=publicRowShape(options,value);if(!shape.supported){const row={id,tags:[],...shape};views.set(id,row);return row;}
   const rowSerial=++serial,u=hmac(Buffer.alloc(32,93),'contention/'+field+'/'+id+'/'+rowSerial).readUInt32LE()%(cf+1);
   const tags=encoder.pieces(value).map(p=>{const k=p+'\0'+u;let e=groups.get(k);if(!e){e={keys:mongoKeys(field,p,u),n:0};groups.set(k,e);}const n=++e.n;
    records.push({id:mongoEsc(e.keys[1],n),value:sealedCount(e.keys[2],n,n)});return mongoTag(e.keys[0],n);
   }).sort();assert.equal(tags.length,shape.tagCount);const row={id,tags,...shape};views.set(id,row);return row;},
  remove(id:string){assert.ok(views.delete(id));},
  update(id:string,value:string){encoder.remove(id);return encoder.insert(id,value);},
  snapshot(compacted=false):Snapshot{const esc=compacted?[...groups.values()].map(g=>({id:mongoEsc(g.keys[1],0),value:sealedCount(g.keys[2],g.n,g.n+1,'anchor')})):records.slice();
   return {model:'C-mongo',field,mode,rows:[...views.values()].map(r=>({...r,tags:[...r.tags]})),esc:esc.sort((a,b)=>a.id.localeCompare(b.id)),metadata:{...encoder.metadata,compacted,escRows:esc.length,ecocRows:compacted?0:records.length,ecocCiphertext:'Opaque randomized documents represented by aggregate count; no linkage is exposed',unsupportedRows:[...views.values()].filter(r=>!r.supported).length}};},
  query(value:string,op:'eq'|'contains'='contains'):QueryView{const v=norm(value),n=Array.from(v).length;
   const unsupported=op==='eq'&&mode!=='eq'?'equality API unavailable for substring profile':op==='contains'&&mode==='eq'?'substring profile disabled':op==='contains'&&(n<2||n>10)?'substring query length outside 2..10':undefined;
   return {model:'C-mongo',field,op,keys:unsupported?[]:Array.from({length:cf+1},(_,u)=>mongoKeys(field,(op==='eq'?'e':'s')+'\0'+v,u).map(k=>k.toString('hex'))).flat(),...(unsupported?{unsupported}:{})};}
 };return encoder;
}
