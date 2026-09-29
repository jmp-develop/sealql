import {createHmac,hkdfSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {frame,hex} from '../../../src/core/bytes.js';
import {profiles,descriptorBytes,searchPieces,searchTokens} from '../../../src/core/search-tokens.js';
import {ring} from '../../attack-extra/codec.js';
import {equivalentLike} from '../../final-return/research-query.js';
import {oracle} from '../../final-return/oracle.js';
import {type Node,type Leaf,type Case} from '../../final-return/common.js';
import {ActiveCodec,norm,scope} from './codec.js';
import {makeProbes,learn,type Strategy} from './probes.js';
import {attacker} from './attack.js';
import {assert,fields,loadRows,save} from './common.js';

const data=await loadRows(),reference=data.slice(0,10000),victim=data.slice(10000,11000);
const cases:Case[]=JSON.parse(readFileSync('bench/results/2026-09-29-final-return/cases.json','utf8'));assert.equal(cases.length,55);assert.equal(data.length,100000);
const output:any={started:new Date().toISOString(),complete:false,rows:data.length,victims:victim.length,reference:reference.length,bits:[16,14,12],attack:[],candidates:[],validation:{exactTokens:0,noFalseNegatives:0},scope:'same',format:'Hypothetical substring descriptor includes selected bit width, HMAC truncation matches width; exact index unchanged (company=2, other=16)',limitations:['Memory candidate counts, not SQL timings','One key and fixed sample','No product code or DB writes','Existing 55 conditions; no general LIKE claim']};
for(const bits of [16,14,12])for(const field of ['phone','address'] as const){
 const codec=new ActiveCodec(field,'product',scope,bits),ref=reference.map(r=>r[field]);
 for(const strategy of ['whole-values','packed-pieces'] as Strategy[]){
  const probes=makeProbes(ref,field,strategy),plain=probes.map(v=>codec.pieces(v)),views=probes.map(value=>({tokens:codec.tokens(value),plainBytes:Buffer.byteLength(value),length:Array.from(norm(value)).length}));
  for(const n of [10,100,1000]){const mapping=learn(plain.slice(0,n),views.slice(0,n).map(v=>v.tokens)),predict=attacker({field,pieces:v=>codec.pieces(v)},ref,probes.slice(0,n),views.slice(0,n),mapping);let values=0,graph=0,capped=0;
   for(const row of victim){const v=row[field],g=predict({tokens:codec.tokens(v),plainBytes:Buffer.byteLength(v),length:Array.from(norm(v)).length});values+=Number(g.value===norm(v));graph+=Number(g.source==='graph'&&g.value===norm(v));capped+=Number(g.graphCapped);}
   const r={bits,field,strategy,n,values,rows:victim.length,percent:values/victim.length*100,learnedLabels:mapping.size,graph,capped};output.attack.push(r);save('bits',output);console.log(JSON.stringify(r));
  }
 }
}
const leafKey=(n:Leaf)=>JSON.stringify([n.field,n.op,n.value]),leaves=new Map<string,Leaf>();
function visit(n:Node){if('all'in n)n.all.forEach(visit);else if('any'in n)n.any.forEach(visit);else leaves.set(leafKey(n),n);}
const normalizedCases=cases.map(c=>({...c,node:equivalentLike(c.node)}));normalizedCases.forEach(c=>visit(c.node));
const matrices=new Map<number,Map<string,Uint8Array>>([16,14,12].map(b=>[b,new Map()]));
for(const field of fields){
 const relevant=[...leaves].filter(([,n])=>n.field===field),exactProfile=profiles('customers',field,{type:'text',search:{exact:field==='company'?{bits:2}:true}})[0];
 const key=Buffer.from(hkdfSync('sha384',ring.key,new Uint8Array(),frame(['sealql/index/v3',ring.keyScopeId,descriptorBytes(exactProfile)]),48));
 const prefix=BigInt(createHmac('sha384',key).update(frame(['scope',scope])).digest().readUInt32BE());
 const exact=(v:string)=>{const piece=searchPieces(exactProfile,v)[0],n=createHmac('sha384',key).update(frame(['value',scope,piece])).digest().readUInt32BE();return String(BigInt.asIntN(64,(prefix<<32n)|BigInt((n>>>(32-exactProfile.bits))*2**(32-exactProfile.bits))));};
 for(const r of data.slice(0,3)){assert.equal(exact(r[field]),(await searchTokens(ring,scope,exactProfile,searchPieces(exactProfile,r[field])))[0]);output.validation.exactTokens++;}
 const codecs=[16,14,12].map(bits=>new ActiveCodec(field,'product',scope,bits));
 const queries=codecs.map(codec=>relevant.map(([id,n])=>({id,n,needed:n.op==='eq'?[exact(n.value)]:[...new Set(searchPieces(codec.p,n.value,n.op as 'contains'|'startsWith'|'endsWith').map(p=>codec.token(hex(p))))],out:new Uint8Array(data.length)})));
 const normValues=data.map(r=>norm(r[field])),expected=relevant.map(([,n])=>normValues.map(v=>oracle(n,{[field]:v})));
 for(let i=0;i<data.length;i++){
  const value=data[i][field],ex=exact(value);
  for(let b=0;b<3;b++){const tokens=new Set(codecs[b].tokens(value));for(let j=0;j<queries[b].length;j++){const q=queries[b][j],candidate=q.n.op==='eq'?ex===q.needed[0]:q.needed.every(t=>tokens.has(t));q.out[i]=Number(candidate);assert.ok(!expected[j][i]||candidate,`False negative ${field}/${q.id}/${codecs[b].bits}`);}}
  if(i%1000===999)codecs.forEach(c=>c.clearValueCache());
 }
 for(let b=0;b<3;b++)for(const q of queries[b])matrices.get(codecs[b].bits)!.set(q.id,q.out);
 output.validation.noFalseNegatives+=relevant.length*data.length*3;console.log(`CANDIDATE FIELD COMPLETE ${field}`);
}
function candidate(n:Node,i:number,m:Map<string,Uint8Array>):boolean{return 'all'in n?n.all.every(c=>candidate(c,i,m)):'any'in n?n.any.some(c=>candidate(c,i,m)):Boolean(m.get(leafKey(n))![i]);}
for(const c of normalizedCases){const counts=[16,14,12].map(bits=>{let count=0;for(let i=0;i<data.length;i++)count+=Number(candidate(c.node,i,matrices.get(bits)!));return count;});output.candidates.push({name:c.name,node:c.node,counts:Object.fromEntries([16,14,12].map((b,i)=>[b,counts[i]])),ratios:Object.fromEntries([16,14,12].map((b,i)=>[b,counts[0]?counts[i]/counts[0]:counts[i]===0?1:null]))});}
output.summary=[16,14,12].map(bits=>{const counts=output.candidates.map((c:any)=>c.counts[bits]);return {bits,mean:counts.reduce((a:number,b:number)=>a+b,0)/counts.length,max:Math.max(...counts),meanRatio:counts.reduce((a:number,b:number)=>a+b,0)/output.candidates.reduce((a:number,c:any)=>a+c.counts[16],0),maxCaseRatio:Math.max(...output.candidates.map((c:any)=>c.ratios[bits]??0)),zeroToPositive:output.candidates.filter((c:any)=>c.counts[16]===0&&c.counts[bits]>0).map((c:any)=>c.name)};});
output.complete=true;output.finished=new Date().toISOString();save('bits',output);console.log(JSON.stringify(output.summary));console.log('COMPLETE bits');
