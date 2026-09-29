import {makeProbes} from '../../final-review/r9-impl/probes.js';
import {decodeAtom} from '../../final-review/r9-impl/codec.js';
import {assert,BitCodec,rows,norm,save,stats} from './common.js';
/** A piece's occurrence signature must be a subset of its bucket signature.
 * Unlike the prior learner, collisions are retained as sets, never discarded.
 * Inputs are chosen plaintext probes and their observed token arrays only. */
function learnBuckets(plain:string[][],encrypted:string[][]){
 const signatures=(lists:string[][])=>{const m=new Map<string,bigint>();lists.forEach((xs,i)=>{const bit=1n<<BigInt(i);for(const x of xs)m.set(x,(m.get(x)??0n)|bit);});return m;};
 const ps=signatures(plain),ts=signatures(encrypted),pieceToBuckets=new Map<string,string[]>(),buckets=new Map<string,string[]>();
 for(const [p,s]of ps){const candidates=[...ts].filter(([,t])=>(s&~t)===0n).map(([t])=>t);pieceToBuckets.set(p,candidates);for(const t of candidates){const a=buckets.get(t)??[];a.push(p);buckets.set(t,a);}}
 return {pieceToBuckets,buckets};
}
/** No keys or victim plaintext. Model is learned from the disjoint phone reference. */
function phoneSolver(reference:string[],pieceToBucket:Map<string,string>,maxStates=2000000){
 const values=reference.map(norm),lengths=new Set(values.map(v=>Array.from(v).length));assert.equal(lengths.size,1);const length=[...lengths][0],alphabet=Array.from({length},(_,i)=>[...new Set(values.map(v=>v[i]))].sort());assert(values.every(v=>/^[\x00-\x7f]*$/.test(v)));
 const tokenFor=new Map<string,string>();for(const [p,t]of pieceToBucket){const a=decodeAtom(p);tokenFor.set(a.kind+'\0'+a.value,t);}
 return (tokens:string[])=>{
  const ids=new Map(tokens.map((t,i)=>[t,i])),all=(1n<<BigInt(tokens.length))-1n,maskFor=(kind:string,value:string)=>{const token=tokenFor.get(kind+'\0'+value);if(token===undefined)return undefined;const id=ids.get(token);return id===undefined?undefined:1n<<BigInt(id);};
  const adjacent=new Map<string,bigint>(),skip=new Map<string,bigint>(),start=new Map<string,bigint>(),end=new Map<string,bigint>();const letters=[...new Set(alphabet.flat())];for(const a of letters){const s=maskFor('start',a),e=maskFor('end',a);if(s!==undefined)start.set(a,s);if(e!==undefined)end.set(a,e);for(const b of letters){const x=maskFor('adjacent',a+b),y=maskFor('skip',a+b);if(x!==undefined)adjacent.set(a+b,x);if(y!==undefined)skip.set(a+b,y);}}
  let states=0,capped=false;const solutions:string[]=[];
  function walk(path:string,seen:bigint){if(++states>maxStates){capped=true;return;}if(solutions.length>=2||capped)return;const i=path.length;if(i===length){if(seen===all)solutions.push(path);return;}
   for(const c of alphabet[i]){let add=0n;if(i===0){const b=start.get(c);if(b===undefined)continue;add|=b;}else{const a=adjacent.get(path.at(-1)!+c);if(a===undefined)continue;add|=a;}if(i>=2){const b=skip.get(path.at(-2)!+c);if(b===undefined)continue;add|=b;}if(i===length-1){const e=end.get(c);if(e===undefined)continue;add|=e;}walk(path+c,seen|add);if(capped||solutions.length>=2)return;}
  }
  walk('',0n);return {solutions,states,capped};
 };
}
const data=rows(),reference=data.slice(0,10000).map(r=>r.phone),victims=data.slice(10000,11000);
const output:any={started:new Date().toISOString(),complete:false,databaseAccess:false,rows:100000,reference:10000,victims:1000,chosenInputs:1000,strategies:['packed-pieces','whole-values'],attack:'Subset-of-signature bucket dictionary + reference-learned phone character positions + adjacent/skip/start/end constraints + equality of complete inferred token set; stop after two solutions',maxStatesPerVictim:2000000,results:[],validation:{probeTokenSets:0,groundTruthAdmissible:0},limitations:['One fixed key and fixture','Learned reference phone format; not a general text attacker','No proof keys, query observations, root key or victim plaintext in learner/solver','Unique solution is established only if DFS finished without cap; two solutions means ambiguous, not safe']};
for(const strategy of ['packed-pieces','whole-values'] as const)for(const bits of [16,12,10]){
 const probes=makeProbes(reference,'phone',strategy);
 const codec=new BitCodec('phone',bits),pieces=probes.map(p=>codec.pieces(p)),views=probes.map(p=>codec.tokens(p)),learned=learnBuckets(pieces,views),single=new Map([...learned.pieceToBuckets].filter(([,ts])=>ts.length===1).map(([p,ts])=>[p,ts[0]]));
 // Preserve ambiguous piece-to-bucket alternatives as separate hypotheses.
 // Filter by known probe outputs only, never by secret mappings/victim truth.
 let models=[single];for(const [p,ts]of learned.pieceToBuckets){assert(ts.length>0);if(ts.length===1)continue;models=models.flatMap(m=>ts.map(t=>new Map([...m,[p,t] as [string,string]])));assert(models.length<=10000,'Dictionary hypothesis bound exceeded');}
 const hypothesesBefore=models.length;models=models.filter(m=>pieces.every((ps,i)=>[...new Set(ps.map(p=>m.get(p)!))].sort().join(',')===views[i].join(',')));assert(models.length>0);
 assert(models.some(m=>[...m].every(([p,t])=>codec.token(p)===t)),'Evaluator: actual mapping must remain among hypotheses');
 for(const m of models)for(let i=0;i<probes.length;i++){assert.deepEqual([...new Set(pieces[i].map(p=>m.get(p)!))].sort(),views[i]);output.validation.probeTokenSets++;}
 const predictors=models.map(m=>phoneSolver(reference,m)),samples:any[]=[];let unique=0,uniqueCorrect=0,firstCorrect=0,ambiguous=0,none=0,capped=0;
 for(const row of victims){const truth=norm(row.phone),tokens=codec.tokens(row.phone);assert(models.some(m=>[...new Set(codec.pieces(row.phone).map(p=>m.get(p)!))].sort().join(',')===tokens.join(',')));output.validation.groundTruthAdmissible++;const solutions=new Set<string>();let states=0,isCapped=false;for(const predict of predictors){const r=predict(tokens);states+=r.states;isCapped||=r.capped;r.solutions.forEach(s=>solutions.add(s));if(solutions.size>=2)break;}const result={solutions:[...solutions],states,capped:isCapped};if(result.capped)capped++;else if(result.solutions.length===1){unique++;uniqueCorrect+=Number(result.solutions[0]===truth);assert.equal(result.solutions[0],truth);}else if(result.solutions.length>=2)ambiguous++;else none++;firstCorrect+=Number(result.solutions[0]===truth);samples.push({id:row.id,states:result.states,solutions:result.solutions.length,capped:result.capped,uniqueCorrect:!result.capped&&result.solutions.length===1&&result.solutions[0]===truth,firstCorrect:result.solutions[0]===truth});}
 const bucketSizes=new Map<string,number>();for(const t of models[0].values())bucketSizes.set(t,(bucketSizes.get(t)??0)+1);
 const result={strategy,bits,pieces:learned.pieceToBuckets.size,unambiguousPieceMappings:single.size,hypothesesBefore,hypotheses:models.length,buckets:bucketSizes.size,collidingBuckets:[...bucketSizes.values()].filter(n=>n>1).length,maxBucketPieces:Math.max(...bucketSizes.values()),unique,uniqueCorrect,uniquePct:uniqueCorrect/victims.length*100,firstCorrect,firstPct:firstCorrect/victims.length*100,ambiguous,none,capped,states:stats(samples.map(r=>r.states)),samples};output.results.push(result);save('collision',output);console.log(JSON.stringify({...result,samples:undefined}));
}
output.complete=true;output.finished=new Date().toISOString();save('collision',output);console.log('COMPLETE collision-aware phone attack');
