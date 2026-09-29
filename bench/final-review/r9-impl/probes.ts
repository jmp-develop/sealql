import {ActiveCodec,decodeAtom,norm} from './codec.js';
import {rng,shuffled} from './common.js';
export type Strategy='whole-values'|'packed-pieces';
/** Chosen inputs are derived from a held-out fixture reference, never from victim plaintext. */
export function makeProbes(reference:string[],field:string,strategy:Strategy):string[]{
 if(strategy==='whole-values')return shuffled(reference,108029).slice(0,1000);
 const codec=new ActiveCodec(field,'product'),freq=new Map<string,number>();for(const value of reference)for(const piece of codec.pieces(value)){const a=decodeAtom(piece);if(a.kind==='adjacent')freq.set(a.value,(freq.get(a.value)??0)+1);}
 const ordered=[...freq].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([p])=>p),random=rng(108029),result:string[]=[];
 for(let i=0;i<1000;i++){const pool=ordered.slice(0,Math.max(256,(i+1)*16)),chosen=new Set<number>();while(chosen.size<Math.min(128,Math.ceil(pool.length/2)))chosen.add(Math.floor(random()*pool.length));result.push([...chosen].map(j=>pool[j]).join(' '));}
 if(result.some(v=>Array.from(norm(v)).length>256))throw new Error('Derived probe exceeds compact length budget');return result;
}
/** Unique equality of known-row membership signatures; no cryptographic oracle in the attacker. */
export function learn(probePlainPieces:string[][],probeTokens:string[][]){const signature=(lists:string[][])=>{const m=new Map<string,bigint>();lists.forEach((xs,i)=>{const bit=1n<<BigInt(i);for(const x of xs)m.set(x,(m.get(x)??0n)|bit);});return m;};const plain=signature(probePlainPieces),encrypted=signature(probeTokens),byPlain=new Map<bigint,string[]>(),byToken=new Map<bigint,string[]>();for(const [p,s]of plain){const a=byPlain.get(s)??[];a.push(p);byPlain.set(s,a);}for(const [t,s]of encrypted){const a=byToken.get(s)??[];a.push(t);byToken.set(s,a);}const result=new Map<string,string>();for(const [t,s]of encrypted){const ps=byPlain.get(s);if(ps?.length===1&&byToken.get(s)?.length===1)result.set(t,ps[0]);}return result;}
