/** Exact reduction of competitor-sim dictionaryPredictor for the measured
 * occurrence-unique/disjoint target case. No secret tag encoder is used.
 * A known token has a singleton-row incidence signature; it receives a label
 * iff exactly one public piece has that singleton signature. Held-out rows
 * have no known tokens, hence their learned signature is always the empty set.
 */
import {norm} from '../../competitor-sim/models.js';
export function occurrenceDictionary(reference:string[],known:string[],pieces:(v:string)=>string[]){
 const signatures=new Map<string,bigint>();known.forEach((v,i)=>{const bit=1n<<BigInt(i);for(const p of new Set(pieces(v)))signatures.set(p,(signatures.get(p)??0n)|bit);});
 const reverse=new Map<bigint,string[]>();for(const [p,s]of signatures){const ps=reverse.get(s)??[];ps.push(p);reverse.set(s,ps);}
 const learned=new Set<string>();for(let i=0;i<known.length;i++){const ps=reverse.get(1n<<BigInt(i));if(ps?.length===1)learned.add(ps[0]);}
 const frequency=new Map<string,number>();for(const v of reference.map(norm))frequency.set(v,(frequency.get(v)??0)+1);
 const prior=[...frequency.keys()].sort((a,b)=>frequency.get(b)!-frequency.get(a)!);
 const value=prior.find(v=>!pieces(v).some(p=>learned.has(p)))??prior[0];
 return {value,learnedLabels:learned.size,knownRows:known.length,requiredInvariant:'All tokens unique across rows; no known-target token or whole-index overlap'};
}
