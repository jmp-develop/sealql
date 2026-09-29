/** Independent small-fixture cryptographic and full-fixture shape checks. No DB. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createOccurrenceModel,publicRowShape,queryHits,rows,fields,norm,type Options,type Snapshot,type QueryView} from '../models.js';
const OUT='bench/results/2026-09-30-mongo-reeval/v-astra';mkdirSync(OUT,{recursive:true});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const enc=new TextEncoder(),bytes=(s:string|Uint8Array)=>typeof s==='string'?enc.encode(s):Uint8Array.from(s);
const concat=(...xs:(string|Uint8Array)[])=>Uint8Array.from(Buffer.concat(xs.map(x=>Buffer.from(bytes(x)))));
const sha=async(...xs:(string|Uint8Array)[])=>Buffer.from(await crypto.subtle.digest('SHA-256',concat(...xs)));
const hmac=async(k:string,data:Uint8Array|string)=>{const key=await crypto.subtle.importKey('raw',Uint8Array.from(Buffer.from(k,'hex')),{name:'HMAC',hash:'SHA-256'},false,['sign']);return Buffer.from(await crypto.subtle.sign('HMAC',key,bytes(data)));};
const number=(n:number,l:number)=>{const b=Buffer.alloc(l);if(l===4)b.writeUInt32BE(n);else b.writeBigUInt64LE(BigInt(n));return b;};
const all=rows(),victim=all.slice(0,10000),reference=all.slice(10000,20000);
const result:any={complete:false,started:new Date().toISOString(),sourceHash:hash(readFileSync('bench/mongo-reeval/models.ts','utf8')),fixtureIdentityHash:hash(JSON.stringify(all.slice(0,20000).map(r=>r.id))),shapeChecks:0,cryptographicTagChecks:0,queryChecks:0,rows:[],errors:[]};
function pieces(field:string,value:string){const v=norm(value),c=Array.from(v),s=new Set<string>(['e\0'+v]);for(let start=0;start<c.length;start++)for(let length=2;length<=10&&start+length<=c.length;length++)s.add('s\0'+c.slice(start,start+length).join(''));if(field==='address'||field==='email')for(let length=2;length<=10&&length<=c.length;length++){s.add('p\0'+c.slice(0,length).join(''));s.add('x\0'+c.slice(-length).join(''));}return [...s];}
async function independentQuery(q:QueryView,s:Snapshot){
 const tags=new Set<string>();if(q.unsupported)return [];
 if(q.model==='C-port'){const key=Buffer.from(q.keys[0],'hex'),eid=(await sha(key,'esc')).toString('hex'),n=s.esc.find(x=>x.id===eid)?.n??0;for(let i=1;i<=n;i++)tags.add((await sha(key,number(i,4))).subarray(0,8).toString('hex'));}
 else {const es=new Map(s.esc.map(e=>[e.id,e]));for(let i=0;i<q.keys.length;i+=3){const [edc,esc,secret]=q.keys.slice(i,i+3);let e=es.get((await hmac(esc,'anchor')).toString('hex'));if(!e){let n=1;while(true){const next=es.get((await hmac(esc,number(n,8))).toString('hex'));if(!next)break;e=next;n++;}}
   if(!e)continue;assert.equal(e.n,undefined);const cipher=Buffer.from(e.value!,'hex'),key=await crypto.subtle.importKey('raw',Uint8Array.from(Buffer.from(secret,'hex')),'AES-CTR',false,['decrypt']);const plain=Buffer.from(await crypto.subtle.decrypt({name:'AES-CTR',counter:Uint8Array.from(cipher.subarray(0,16)),length:128},key,Uint8Array.from(cipher.subarray(16))));const n=Number(plain.readBigUInt64LE());for(let j=1;j<=n;j++)tags.add((await hmac(edc,number(j,8))).toString('hex'));
  }}
 return s.rows.flatMap((r,i)=>r.supported&&r.tags.some(t=>tags.has(t))?[i]:[]);
}
try{
 assert.equal(result.fixtureIdentityHash,'189a19c99711fbacd9cafdb548f243a63657e12a0c1514a736c1f92da670f382');
 for(const field of fields){
  let unsupported=0;for(const r of [...victim,...reference]){const value=norm(r[field]),cs=Array.from(value),E=(Math.floor((Buffer.byteLength(value)+5)/16)+1)*16,P=Math.min(60,E-5);let count=1;for(let i=0;i<P;i++)for(let j=i+2;j<=P&&j<=i+10;j++)count++;const shape=publicRowShape({id:'C-mongo',field,mode:'partial'},value);assert.deepEqual(shape,{tagCount:count,cipherBytes:E,supported:cs.length<=60});if(!shape.supported)unsupported++;result.shapeChecks++;}
  for(const options of [{id:'C-port',field,mode:'combined'},{id:'C-mongo',field,mode:'partial'},{id:'C-mongo',field,mode:'eq'}] as Options[]){
   const model=createOccurrenceModel(options),values=victim.slice(0,20).map(r=>r[field]);values.push(values[0],values[0]);const counter=new Map<string,number>();
   for(let i=0;i<values.length;i++){const row=model.insert(String(i),values[i]);if(options.id==='C-port'){const expected=[];for(const p of pieces(field,values[i])){const n=(counter.get(p)??0)+1;counter.set(p,n);const key=await sha(Buffer.alloc(32,7),'customers\0'+field+'\0'+p);expected.push((await sha(key,number(n,4))).subarray(0,8).toString('hex'));result.cryptographicTagChecks++;}assert.deepEqual(row.tags,expected.sort());}}
   const before=model.snapshot(false),after=model.snapshot(true),seen=new Set<string>();for(const row of before.rows)for(const tag of row.tags){assert.ok(!seen.has(tag),'Occurrence tags must not repeat across rows/padding');seen.add(tag);}
   if(options.id==='C-mongo'){assert.ok(before.esc.every(e=>e.n===undefined));assert.ok(after.esc.every(e=>e.n===undefined));assert.equal(before.metadata.ecocRows,before.esc.length);assert.equal(after.metadata.ecocRows,0);assert.deepEqual(before.rows,after.rows);}
   const op=options.mode==='eq'?'eq':'contains';for(const value of values.slice(0,8)){const term=op==='eq'?norm(value):Array.from(norm(value)).slice(0,3).join('');if(Array.from(term).length<2)continue;const query=model.query(term,op);for(const snap of [before,after]){const expected=snap.rows.flatMap((r,i)=>r.supported&&(op==='eq'?norm(values[i])===term:norm(values[i]).includes(term))?[i]:[]);assert.deepEqual(await independentQuery(query,snap),expected);assert.deepEqual(queryHits(query,snap),expected);result.queryChecks++;}}
   model.remove('1');model.update('2',values[0]);const changed=model.snapshot(true),q=model.query(norm(values[0]),'eq');if(!q.unsupported){const expected=changed.rows.flatMap((r,i)=>norm(values[Number(r.id)==2?0:Number(r.id)])===norm(values[0])?[i]:[]);assert.deepEqual(await independentQuery(q,changed),expected);result.queryChecks++;}
   result.rows.push({field,model:options.id,mode:options.mode,rows:values.length,tags:seen.size,escBefore:before.esc.length,escAfter:after.esc.length,unsupportedVictimAndReference:unsupported});
  }
 }
 result.complete=true;
}catch(e){result.errors.push(String(e));throw e;}finally{result.finished=new Date().toISOString();writeFileSync(`${OUT}/verify-models.json`,JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({complete:result.complete,shapeChecks:result.shapeChecks,cryptographicTagChecks:result.cryptographicTagChecks,queryChecks:result.queryChecks,models:result.rows.length}));
