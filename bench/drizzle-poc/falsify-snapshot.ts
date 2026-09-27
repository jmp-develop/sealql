import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { hex } from '../../src/core/bytes.js';
import { profiles, searchPieces, searchTokens } from '../../src/core/search-tokens.js';
import { binding, guard, pool, schema, scopeId, sealer, source } from '../standard-next/common.js';

const out=new URL('../results/2026-09-27-drizzle-falsify/',import.meta.url);await mkdir(out,{recursive:true});
const n=20000,knownCount=1000;let result:any={};
const b=binding('customers'),profile=profiles(b.model.id,'memo',b.model.fields.memo).find(p=>p.mode==='substring')!;
const column=b.storage.index!.profiles![profile.indexId].tokens;
const ring=sealer.ring(profile.modelId),cache={profiles:new Map<string,Promise<CryptoKey>>()};
const labels=(v:string)=>[...new Set(searchPieces(profile,v).map(hex))];
const sorted=(a:string[])=>[...new Set(a.map(String))].sort();
function score(rows:{pieces:string[];tokens:string[]}[],references:string[][],known:Set<number>,oracle:Map<string,string>){
 const tokenFreq=new Map<string,number>(),pieceFreq=new Map<string,number>();
 for(const r of rows)for(const t of r.tokens)tokenFreq.set(t,(tokenFreq.get(t)??0)+1);
 for(const p of references)for(const x of p)pieceFreq.set(x,(pieceFreq.get(x)??0)+1);
 const ranksA=[...tokenFreq].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);const ranksB=[...pieceFreq].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
 const frequency=new Map(ranksA.map((t,i)=>[t,ranksB[i]]).filter(x=>!!x[1]) as [string,string][]);
 const tokenSig=new Map<string,number[]>(),pieceSig=new Map<string,number[]>();
 rows.forEach((r,i)=>{if(!known.has(i))return;for(const t of r.tokens)(tokenSig.get(t)??tokenSig.set(t,[]).get(t)!).push(i);for(const p of r.pieces)(pieceSig.get(p)??pieceSig.set(p,[]).get(p)!).push(i);});
 const bySig=new Map<string,string[]>();for(const [p,ids] of pieceSig){const sig=ids.join(',');(bySig.get(sig)??bySig.set(sig,[]).get(sig)!).push(p);}
 const guessed=new Map<string,string>();for(const [t,ids] of tokenSig){const options=bySig.get(ids.join(','));if(options?.length===1)guessed.set(t,options[0]);}
 const assess=(guess:Map<string,string>)=>{let total=0,right=0,unknown=0,mostly=0;rows.forEach((r,i)=>{let rowRight=0;for(const p of r.pieces){total++;if(guess.get(oracle.get(p)!)===p){right++;rowRight++;}}if(!known.has(i)){unknown++;if(r.pieces.length&&rowRight/r.pieces.length>=.8)mostly++;}});return {decodedOccurrencePct:+(100*right/total).toFixed(2),mostlyDecodedUnknownRowsPct:+(100*mostly/unknown).toFixed(2)};};
 return {frequency:assess(frequency),knownRow:assess(guessed),uniquePieces:oracle.size,uniqueTokens:tokenFreq.size};
}
try{
 await guard();
 const data=(await pool.query(`select p.memo_plain,i.${column} tokens from ${source}.customers p join ${schema}.customers_seal_index i on i.scope_id=p.scope_id and i.row_id=p.id where p.scope_id=$1 order by p.id limit $2`,[scopeId,n*2])).rows;
 assert.equal(data.length,n*2);
 const victims=data.slice(0,n).map(r=>({pieces:labels(r.memo_plain),tokens:sorted(r.tokens??[])}));
 const refs=data.slice(n).map(r=>labels(r.memo_plain));
 const candidate=[];let mismatch=0;
 for(let i=0;i<n;i++){
  const tokens=sorted(await searchTokens(ring,scopeId,profile,searchPieces(profile,data[i].memo_plain),cache));
  if(JSON.stringify(tokens)!==JSON.stringify(victims[i].tokens))mismatch++;
  candidate.push({pieces:victims[i].pieces,tokens});
  if((i+1)%5000===0)console.log(`regenerated ${i+1}/${n}`);
 }
 const oracle=new Map<string,string>();for(const p of new Set(victims.flatMap(x=>x.pieces)))oracle.set(p,(await searchTokens(ring,scopeId,profile,[Buffer.from(p,'hex')],cache))[0]);
 let state=99;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296;};
 const known=new Set<number>();while(known.size<knownCount)known.add(Math.floor(random()*n));
 const baseline=score(victims,refs,known,oracle),rowlessCandidate=score(candidate,refs,known,oracle);
 result={source:'existing 20k victim and 20k reference rows, memo token arrays; rowless AAD changes only ciphertext and leaves product token profile unchanged',rows:n,referenceRows:n,knownRows:knownCount,mismatch,baseline,rowlessCandidate,scoresEqual:JSON.stringify(baseline)===JSON.stringify(rowlessCandidate)};
 assert.equal(mismatch,0);assert(result.scoresEqual);
}catch(e:any){result.error={message:e.message,stack:e.stack};process.exitCode=1;}
finally{await pool.end();await writeFile(new URL('snapshot.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
