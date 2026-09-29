import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {createHmac,hkdfSync,hash} from 'node:crypto';
import {rows,fields,norm,rng,makeModels,assert,Codec,ring,scope,unique} from './models.js';
import {score,counts} from './attacks.js';
import {inferQueryLabels,observationGuesses,inferPositionLabels,positionGuesses,fillPositions,type Observation,type OpaqueLocations} from './observation.js';
import {positions} from '../attack-extra/codec.js';
import {compileStampQuery} from '../../src/core/stamp-query.js';
import {stampKey} from '../../src/core/search-stamps.js';
import {frame,u32,utf8} from '../../src/core/bytes.js';
const OUT='bench/results/2026-09-30-competitor-sim/r9-impl';mkdirSync(OUT,{recursive:true});
const save=(name:string,data:unknown)=>writeFileSync(`${OUT}/${name}.json`,JSON.stringify(data,null,2)+'\n');
const data=rows(),victims=data.slice(0,10000),reference=data.slice(10000,20000),seed=714029,assign=rng(seed),schedule=Array.from({length:1000},()=>Math.floor(assign()*fields.length));
const result:any=process.argv.includes('--resume')&&existsSync(`${OUT}/observed.json`)?JSON.parse(readFileSync(`${OUT}/observed.json`,'utf8')):{complete:false,databaseAccess:false,seed,observations:1000,assignment:schedule,victims:10000,reference:10000,identityDigest:hash('sha256',JSON.stringify([...victims,...reference].map(r=>r.id))),results:[],checks:0};
const stamp=(key:Uint8Array,salt:Uint8Array)=>hash('sha256',Buffer.concat([key,salt]),'buffer').readBigInt64BE();
function terms(raw:string[]){const counts=new Map<string,number>();for(const v of raw)for(const word of v.match(/[\p{L}\p{N}]+/gu)??[]){const q=norm(word),n=Array.from(q).length;if(n>=3&&n<=45)counts.set(q,(counts.get(q)??0)+1);}return [...counts];}
function draw(items:[string,number][],random:()=>number){const target=random()*items.reduce((a,b)=>a+b[1],0);let n=0;for(const [v,c]of items){n+=c;if(n>target)return v;}return items.at(-1)![0];}
function tokenHits(views:string[][],tokens:string[]){const required=new Set(tokens);return views.flatMap((ts,i)=>{const present=new Set(ts);return [...required].every(t=>present.has(t))?[i]:[];});}
for(const [f,field]of fields.entries()){
 const truth=victims.map(r=>norm(r[field])),ref=reference.map(r=>norm(r[field])),raw=reference.map(r=>r[field]);
 const count=schedule.filter(i=>i===f).length,randomEq=rng(seed+f),randomPartial=rng(seed+f),dictionary=terms(raw);
 const eqQueries=Array.from({length:count},()=>ref[Math.floor(randomEq()*ref.length)]),partialQueries=Array.from({length:count},()=>draw(dictionary,randomPartial));
 const models=makeModels(field,ref);
 for(const model of models){
  const modes=model.kind==='exact'?['eq']:model.id==='S0'?['eq','partial']:['partial'];
  const views=truth.map(model.tokens);
  for(const mode of modes){
   if(result.results.some((r:any)=>r.field===field&&r.model===model.id&&r.mode===mode))continue;
   const queries=[...new Set(mode==='eq'?eqQueries:partialQueries)],observations:Observation[]=[];
   const pieceCache=new Map<string,Set<string>>(),queryCache=new Map<string,string[]>();
   const accepts=(v:string,q:string)=>mode==='eq'?v===q:model.kind==='bloom'?(()=>{let ps=pieceCache.get(v);if(!ps){ps=new Set(model.pieces(v));pieceCache.set(v,ps);}let qp=queryCache.get(q);if(!qp){qp=model.queryPieces(q);queryCache.set(q,qp);}return qp.every(p=>ps!.has(p));})():v.includes(q);
   let positional:OpaqueLocations[]|undefined,knownPieceLabels:Map<string,string>|undefined,lengths:number[]|undefined;
   if(model.id==='S0'&&mode==='eq'){
    const root=Buffer.from(hkdfSync('sha384',ring.key,Buffer.alloc(0),frame(['sealql/search-stamp/v1',ring.keyScopeId,'customers',field,'text',u32(2),new Uint8Array(),'legacy-text-v1','exact']),32));
    const key=(v:string)=>createHmac('sha256',root).update(frame([scope,utf8(v)])).digest();
    const snapshots=truth.map((v,i)=>{const salt=hash('sha256',`eq/${field}/${victims[i].id}`,'buffer').subarray(0,16);return {salt,stamp:stamp(key(v),salt)};});
    for(const q of queries){const observedKey=key(q),hits=snapshots.flatMap((s,i)=>stamp(observedKey,s.salt)===s.stamp?[i]:[]);observations.push({opaque:observedKey.toString('hex'),hits,label:q});assert.deepEqual(hits,truth.flatMap((v,i)=>v===q?[i]:[]));result.checks++;}
   } else if(model.id==='S0'){
    const codec=new Codec(field),snapshots=truth.map((v,i)=>codec.snapshot(v,hash('sha256',`positions/${field}/${victims[i].id}`,'buffer').subarray(0,16))),byKey=new Map<string,OpaqueLocations>();knownPieceLabels=new Map();lengths=snapshots.map(s=>s.n);
    for(const q of queries){const proof=await compileStampQuery(ring,codec.p,scope,{op:'contains',value:q}),keys=proof.keys.map(k=>Buffer.from(k).toString('hex')),cs=Array.from(q);
     for(let i=0;i<keys.length;i++){knownPieceLabels.set(keys[i],cs.slice(proof.offsets[i],proof.offsets[i]+2).join(''));if(byKey.has(keys[i]))continue;
      const locations=new Map<number,number[]>();let occurrences=0;snapshots.forEach((s,r)=>{const ps=positions(s,proof.keys[i]);if(ps.length){locations.set(r,ps);occurrences+=ps.length;}});byKey.set(keys[i],{opaque:keys[i],locations,docs:locations.size,occurrences});
     }
     const hits=[...byKey.get(keys[0])!.locations].filter(([r,ps])=>ps.some(p=>keys.every((k,i)=>byKey.get(k)!.locations.get(r)?.includes(p+proof.offsets[i]-proof.offsets[0])))).map(([r])=>r);
     assert.deepEqual(hits,truth.flatMap((v,i)=>v.includes(q)?[i]:[]));result.checks++;observations.push({opaque:keys.join('/'),label:q,hits});
    }positional=[...byKey.values()];
   } else for(const q of queries){const tokens=model.query(q);observations.push({opaque:tokens.join(','),hits:tokenHits(views,tokens),label:q});}
   const known=observationGuesses(ref,truth.length,observations,accepts);
   const opaque=observations.map(({opaque,hits})=>({opaque,hits}));
   const unknownLabels=inferQueryLabels(ref,opaque,mode==='eq'?ref:dictionary.map(([q])=>q),accepts,mode==='eq'?counts(ref):undefined),unknown=observationGuesses(ref,truth.length,unknownLabels,accepts);
   let knownCombined=known,unknownCombined=unknown,knownPartial:string[]|undefined,unknownPartial:string[]|undefined;
   if(positional){
    const kp=positionGuesses(lengths!,positional,knownPieceLabels!),up=positionGuesses(lengths!,positional,inferPositionLabels(ref,positional));
    knownPartial=kp.map(cs=>cs.map(c=>c??'\ufffd').join(''));unknownPartial=up.map(cs=>cs.map(c=>c??'\ufffd').join(''));
    knownCombined=fillPositions(ref,kp,known);unknownCombined=fillPositions(ref,up,unknown);
   }
   const row={field,model:model.id,mode,fieldObservations:count,distinctQueries:queries.length,known:score(truth,known),unknown:score(truth,unknown),knownCombined:score(truth,knownCombined),unknownCombined:score(truth,unknownCombined),knownPositions:knownPartial?score(truth,knownPartial):undefined,unknownPositions:unknownPartial?score(truth,unknownPartial):undefined};
   result.results.push(row);save(`observed-${field}-${model.id}-${mode}`,{...row,observedQueries:mode==='eq'?eqQueries:partialQueries,observations,unknownAssignedLabels:unknownLabels.map(o=>o.label),predictions:{known,unknown,knownCombined,unknownCombined,knownPartial,unknownPartial},positionKeys:positional?.map(o=>({opaque:o.opaque,docs:o.docs,occurrences:o.occurrences}))});save('observed',result);console.log(JSON.stringify(row));
  }
 }
}
result.complete=true;save('observed',result);console.log('COMPLETE D');
