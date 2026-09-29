import {hash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {frame,hex,utf8} from '../../../src/core/bytes.js';
import {positionProof} from '../../../src/core/search-stamps.js';
import {ring,profile} from '../../attack-extra/codec.js';
import {ActiveCodec,type Generation,norm,scope,otherScope} from './codec.js';
import {makeProbes,learn,type Strategy} from './probes.js';
import {attacker,type View} from './attack.js';
import {assert,fields,loadRows,rng,save,OUT} from './common.js';
const arg=(name:string,fallback:string)=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:fallback;
const size=Number(arg('--size','1000')),strategyArg=arg('--strategy','both'),strategies:Strategy[]=strategyArg==='both'?['whole-values','packed-pieces']:[strategyArg as Strategy];
assert.ok([1000,10000,90000].includes(size));assert.ok(strategies.every(s=>['whole-values','packed-pieces'].includes(s)));
const raw=await loadRows();assert.equal(raw.length,100000);const reference=raw.slice(0,10000),victim=raw.slice(10000,10000+size);assert.equal(victim.length,size);
const result:any={started:new Date().toISOString(),complete:false,seed:108029,totalFixtureRows:raw.length,referenceRows:reference.length,unknownVictimRows:victim.length,disjointIds:new Set([...reference,...victim].map(r=>r.id)).size===reference.length+victim.length,victimIdsDigest:hash('sha256',victim.map(r=>r.id).join('\n')),probeCounts:[10,100,1000],strategies,rows:[],validation:{product:0,previous:0,research:0,crossScope:0,saltedKnownRows:0,stampOverlap:0},limitations:['No query keys are observed','Selected input is reference-fixture-derived, in memory only','Packed input assumes arbitrary text accepted, maximum 256 compact characters; field-specific application validation not bypassed','Large fixture snapshot has 100000 existing rows, 10000 reference rows excluded from scoring','No product/DB mutation or timing benchmark'],sources:{product:'src/core/search-tokens.ts',previous:'f9005bd:src/core/search-tokens.ts',research:'bench/final-return/research-codec.ts'}};
const output=`active-${size}-${strategyArg}`;save(output,result);
for(const field of fields){
 const truth=victim.map(r=>r[field]),ref=reference.map(r=>r[field]),metadata=truth.map(value=>{
  const chars=Array.from(norm(value));
  const adjacent=Array.from({length:Math.max(0,chars.length-1)},(_,i)=>hex(frame(['adjacent',utf8(chars[i]+chars[i+1])])));
  return {value:chars.join(''),chars,plainBytes:Buffer.byteLength(value),adjacent};
 });
 const inputs=new Map(strategies.map(strategy=>[strategy,makeProbes(ref,field,strategy)]));
 for(const generation of ['pre-r9','research','product'] as Generation[]){
  const codec=new ActiveCodec(field,generation),cross=new ActiveCodec(field,generation,otherScope),sameView:View[]=truth.map(value=>({tokens:codec.tokens(value),plainBytes:Buffer.byteLength(value),...(generation==='pre-r9'?{}:{length:Array.from(norm(value)).length})}));
  const otherTokens=truth.map(value=>cross.tokens(value));
  if(size===1000){for(const value of [...truth.slice(0,3),...inputs.get(strategies[0])!.slice(0,2)]){await codec.validate(value);result.validation[generation==='pre-r9'?'previous':generation==='product'?'product':'research']++;if(generation!=='research'){await cross.validate(value);result.validation.crossScope++;}}
   if(generation==='product')for(const value of truth.slice(0,3)){const a=await positionProof(ring,profile(field),scope,value,'compact2'),b=await positionProof(ring,profile(field),scope,value,'compact2');assert.notDeepEqual(a.salt,b.salt);const overlap=a.stamps.filter(s=>b.stamps.includes(s)).length;assert.equal(overlap,0);result.validation.saltedKnownRows++;result.validation.stampOverlap+=overlap;}
  }
  function evaluate(mapping:Map<string,string>,probes:string[],probeViews:View[]){
   const predict=attacker({field,pieces:v=>codec.pieces(v)},ref,probes,probeViews,mapping),random=rng(108029),m={rows:truth.length,values:0,characters:0,characterTotal:0,adjacentOccurrences:0,adjacentTotal:0,guessedPieces:0,correctGuessedPieces:0,mostly:0,graphValues:0,graphRows:0,graphCapped:0,graphStates:0,randomValues:0,randomCharacters:0,randomAdjacentOccurrences:0,randomPieceExpectedCorrect:0,sources:{'inserted-fingerprint':0,dictionary:0,prior:0,graph:0}};
   for(let i=0;i<truth.length;i++){const meta=metadata[i],view=sameView[i],prediction=predict(view),guess=Array.from(prediction.value),randomGuess=Array.from(norm(ref[Math.floor(random()*ref.length)])),correct=meta.chars.filter((c,j)=>c===guess[j]).length;
    const exact=prediction.value===meta.value;m.values+=Number(exact);m.characters+=correct;m.characterTotal+=meta.chars.length;m.mostly+=Number(correct>=meta.chars.length*.8);m.randomValues+=Number(randomGuess.join('')===meta.value);m.randomCharacters+=meta.chars.filter((c,j)=>c===randomGuess[j]).length;m.sources[prediction.source]++;m.graphStates+=prediction.graphStates;m.graphCapped+=Number(prediction.graphCapped);if(prediction.source==='graph'){m.graphRows++;m.graphValues+=Number(exact);}
    const known=view.tokens.flatMap(t=>mapping.has(t)?[mapping.get(t)!]:[]),actual=new Set(codec.pieces(truth[i])),correctPieces=new Set(known.filter(p=>actual.has(p)));m.guessedPieces+=known.length;m.correctGuessedPieces+=correctPieces.size;m.adjacentTotal+=meta.adjacent.length;m.adjacentOccurrences+=meta.adjacent.filter(p=>correctPieces.has(p)).length;
    for(let j=0;j+1<meta.chars.length;j++)m.randomAdjacentOccurrences+=Number(meta.chars[j]===randomGuess[j]&&meta.chars[j+1]===randomGuess[j+1]);
   }
   const vocabulary=new Set(ref.flatMap(v=>codec.pieces(v))),avgActualPieces=truth.reduce((sum,v)=>sum+codec.pieces(v).length,0)/truth.length;m.randomPieceExpectedCorrect=m.guessedPieces*avgActualPieces/vocabulary.size;
   return m;
  }
  const baseline=evaluate(new Map(),[],[]);result.rows.push({field,generation,strategy:'none',scope:'same',inserted:0,...baseline});save(output,result);
  for(const strategy of strategies){const probes=inputs.get(strategy)!,probePieces=probes.map(v=>codec.pieces(v)),probeViews=probes.map(value=>({tokens:codec.tokens(value),plainBytes:Buffer.byteLength(value),...(generation==='pre-r9'?{}:{length:Array.from(norm(value)).length})}));
   for(const count of [10,100,1000]){
    const mapping=learn(probePieces.slice(0,count),probeViews.slice(0,count).map(v=>v.tokens)),selfCorrect=[...mapping].filter(([t,p])=>codec.token(p)===t).length,metrics=evaluate(mapping,probes.slice(0,count),probeViews.slice(0,count));
    const info={field,generation,strategy,inserted:count,learnedLabels:mapping.size,correctLearnedLabels:selfCorrect,maxProbeCompactLength:Math.max(...probes.slice(0,count).map(v=>Array.from(norm(v)).length)),probeUtf8Bytes:probes.slice(0,count).reduce((s,v)=>s+Buffer.byteLength(v),0)};
    result.rows.push({...info,scope:'same',...metrics});let transfer=0,correctTransfer=0;for(let i=0;i<otherTokens.length;i++){const actual=new Set(cross.pieces(truth[i]));for(const token of otherTokens[i]){const p=mapping.get(token);if(p){transfer++;correctTransfer+=Number(actual.has(p));}}}
    // Distinct scopes make learned labels inapplicable: do not turn nonmatching tokens into negative plaintext evidence.
    assert.equal(transfer,0,'Unexpected full-token scope collision: inspect before claiming isolation');result.rows.push({...info,scope:'different',...baseline,transferredLabelMatches:transfer,correctTransferredLabels:correctTransfer});save(output,result);
    console.log(JSON.stringify({size,field,generation,strategy,count,labels:mapping.size,values:metrics.values,rows:metrics.rows,adjacent:metrics.adjacentOccurrences,total:metrics.adjacentTotal,graph:metrics.graphValues,crossScope:transfer}));
   }
  }
 }
}
result.complete=true;result.finished=new Date().toISOString();save(output,result);console.log(`COMPLETE ${OUT}/${output}.json`);
