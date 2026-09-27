/** Keyless frequency and 5% known-row count attacks on the actual new memo token arrays.
 * The key is used only by the scorer to label guessed tokens after the attack.
 */
import { writeFile } from 'node:fs/promises';
import { hex } from '../../src/core/bytes.js';
import { profiles, searchPieces, searchTokens } from '../../src/core/search-tokens.js';
import { binding, guard, pool, schema, scopeId, sealer, source } from './common.js';
import { oldPieces, oldToken } from './old-oracle.js';

const n=20000,seed=99;
const b0=binding('customers'),b1=binding('customers',true);
const p0=profiles(b0.model.id,'memo',b0.model.fields.memo).find(p=>p.mode==='substring')!;
const p1=profiles(b1.model.id,'memo',b1.model.fields.memo).find(p=>p.mode==='substring')!;
const c0=b0.storage.index!.profiles![p0.indexId].tokens,c1=b1.storage.index!.profiles![p1.indexId].tokens;
const cache={profiles:new Map<string,Promise<CryptoKey>>()};
let randomSeed=seed;const random=()=>{randomSeed^=randomSeed<<13;randomSeed^=randomSeed>>>17;randomSeed^=randomSeed<<5;return(randomSeed>>>0)/4294967296;};
const known=new Set<number>();while(known.size<n*.05)known.add(Math.floor(random()*n));
function add(map:Map<string,number>,key:string){map.set(key,(map.get(key)??0)+1);}
function score(guess:Map<string,string>,rows:{pieces:string[];tokens:string[]}[],oracle:Map<string,string>){
  let total=0,correct=0,mostly=0,unknown=0;
  for(let i=0;i<rows.length;i++){
    let rowCorrect=0;for(const piece of rows[i].pieces){total++;if(guess.get(oracle.get(piece)!)===piece){correct++;rowCorrect++;}}
    if(!known.has(i)){unknown++;if(rows[i].pieces.length&&rowCorrect/rows[i].pieces.length>=.8)mostly++;}
  }
  return {decodedOccurrencePct:+(100*correct/total).toFixed(2),mostlyDecodedUnknownRowsPct:+(100*mostly/unknown).toFixed(2)};
}
function signature(rows:number[]){return rows.join(',');}
async function run(variant:'old'|'next'|'skip',data:any[]){
  const skip=variant==='skip',profile=skip?p1:p0,field=variant==='old'?'old_tokens':skip?'skip_tokens':'plain_tokens';
  const pieces=(value:string)=>variant==='old'?oldPieces(value):searchPieces(profile,value).map(hex);
  const victim=data.slice(0,n).map(row=>({pieces:[...new Set(pieces(row.memo_plain))],tokens:[...new Set((row[field]??[]).map(String))] as string[]}));
  const reference=data.slice(n).map(row=>[...new Set(pieces(row.memo_plain))]);
  const oracle=new Map<string,string>(),ring=sealer.ring(profile.modelId);
  for(const piece of new Set(victim.flatMap(row=>row.pieces))){
    const token=variant==='old'?oldToken(piece):(await searchTokens(ring,scopeId,profile,[Buffer.from(piece,'hex')],cache))[0];oracle.set(piece,token);
  }
  const tf=new Map<string,number>(),pf=new Map<string,number>();
  for(const row of victim)for(const token of row.tokens)add(tf,token);
  for(const row of reference)for(const piece of row)add(pf,piece);
  const rankedTokens=[...tf].sort((a,b)=>b[1]-a[1]).map(x=>x[0]),rankedPieces=[...pf].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
  const frequency=new Map(rankedTokens.map((token,i)=>[token,rankedPieces[i]]).filter((x):x is [string,string]=>!!x[1]));
  const tokenSig=new Map<string,number[]>(),pieceSig=new Map<string,number[]>();
  victim.forEach((row,i)=>{if(!known.has(i))return;for(const token of row.tokens)(tokenSig.get(token)??tokenSig.set(token,[]).get(token)!).push(i);
    for(const piece of row.pieces)(pieceSig.get(piece)??pieceSig.set(piece,[]).get(piece)!).push(i);});
  const bySignature=new Map<string,string[]>();for(const [piece,ids] of pieceSig){const sig=signature(ids);(bySignature.get(sig)??bySignature.set(sig,[]).get(sig)!).push(piece);}
  const knownGuess=new Map<string,string>();for(const [token,ids] of tokenSig){const matches=bySignature.get(signature(ids));if(matches?.length===1)knownGuess.set(token,matches[0]);}
  let missing=0;for(const row of victim){const tokens=new Set(row.tokens);for(const piece of row.pieces)if(!tokens.has(oracle.get(piece)!))missing++;}
  return {layout:variant==='old'?'old-adjacent':skip?'adjacent+boundary+skip':'adjacent+boundary',rows:n,referenceRows:n,knownRows:known.size,
    frequency:score(frequency,victim,oracle),knownRow:score(knownGuess,victim,oracle),uniquePieces:oracle.size,uniqueTokens:tf.size,
    oraclePieceMissingOccurrences:missing,
    skipConsistency:skip?{decodedSkipTokens:[...knownGuess].filter(([,piece])=>Buffer.from(piece,'hex').includes(Buffer.from('skip'))).length,note:'Decoded skip-piece consistency is additionally measured on the independent public review corpus in token-attack.json.'}:undefined};
}
try{
  await guard();
  const data=(await pool.query(`select p.memo_plain,o.tokens_a639b11c8130dcf7 old_tokens,i.${c0} plain_tokens,j.${c1} skip_tokens from ${source}.customers p join ${source}.customers_std_comp_idx o on o.scope_id=p.scope_id and o.row_id=p.id join ${schema}.customers_seal_index i on i.scope_id=p.scope_id and i.row_id=p.id join ${schema}.customers_skip_seal_index j on j.scope_id=p.scope_id and j.row_id=p.id where p.scope_id=$1 order by p.id limit $2`,[scopeId,n*2])).rows;
  if(data.length!==n*2)throw new Error(`Expected ${n*2} rows, got ${data.length}`);
  const report={source:'actual previous and new companion memo token arrays, first 20k victims and next 20k same-source reference rows; synthetic fixture',seed,layouts:[await run('old',data),await run('next',data),await run('skip',data)]};
  await writeFile('bench/results/2026-09-27-standard-next/db-attack.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await pool.end();}
