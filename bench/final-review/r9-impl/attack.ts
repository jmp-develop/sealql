import {ActiveCodec,decodeAtom,norm} from './codec.js';
export interface View {tokens:string[];plainBytes:number;length?:number}
export interface Guess {value:string;source:'inserted-fingerprint'|'dictionary'|'prior'|'graph';graphStates:number;graphCapped:boolean}
/** Prediction accepts only leaked views, controlled insert views, and independent reference plaintext. */
export function attacker(codec:Pick<ActiveCodec,'field'|'pieces'>,reference:string[],probes:string[],probeViews:View[],mapping:Map<string,string>){
 const counts=new Map<string,number>(),byteLengths=new Map<string,Set<number>>(),refRaw=new Map<string,string>();for(const value of reference){const n=norm(value);counts.set(n,(counts.get(n)??0)+1);const b=byteLengths.get(n)??new Set();b.add(Buffer.byteLength(value));byteLengths.set(n,b);refRaw.set(n,value);}
 const candidates=[...counts.keys()].sort((a,b)=>counts.get(b)!-counts.get(a)!),chars=new Map(candidates.map(v=>[v,Array.from(v)])),pieces=new Map(candidates.map(v=>[v,new Set(codec.pieces(refRaw.get(v)!))]));
 const mappedLabels=[...new Set(mapping.values())].sort(),ids=new Map(mappedLabels.map((p,i)=>[p,i])),labelToTokens=new Map<string,string[]>();for(const [t,p]of mapping){const a=labelToTokens.get(p)??[];a.push(t);labelToTokens.set(p,a);}
 const signature=(labels:string[])=>labels.map(p=>ids.get(p)).filter((x):x is number=>x!==undefined).sort((a,b)=>a-b).join(',');
 const bySignature=new Map<string,string[]>(),byBytes=new Map<number,string[]>();for(const value of candidates){const key=signature([...pieces.get(value)!]),a=bySignature.get(key)??[];a.push(value);bySignature.set(key,a);for(const b of byteLengths.get(value)!){const list=byBytes.get(b)??[];list.push(value);byBytes.set(b,list);}}
 const inserted=new Map<string,string>();probes.forEach((v,i)=>inserted.set(probeViews[i].tokens.join(','),norm(v)));
 const atoms=new Map(mappedLabels.map(p=>[p,decodeAtom(p)])),allAlphabet=[...new Set(reference.flatMap(v=>Array.from(norm(v))))];
 const observedAbsent=(id:string,tokens:Set<string>)=>labelToTokens.has(id)&&!labelToTokens.get(id)!.some(t=>tokens.has(t));
 const pairIds=new Map<string,string>();for(const [id,a]of atoms)pairIds.set(a.kind+'\0'+a.value,id);
 return (view:View):Guess=>{
  const tokenSet=new Set(view.tokens),known=view.tokens.flatMap(t=>mapping.has(t)?[mapping.get(t)!]:[]),sameBytes=(v:string)=>byteLengths.get(v)!.has(view.plainBytes),sameLength=(v:string)=>view.length===undefined||chars.get(v)!.length===view.length;
  const direct=inserted.get(view.tokens.join(','));if(direct!==undefined)return {value:direct,source:'inserted-fingerprint',graphStates:0,graphCapped:false};
  const list=bySignature.get(signature(known))??[],dictionary=list.find(v=>sameBytes(v)&&sameLength(v)),prior=(byBytes.get(view.plainBytes)??[]).find(sameLength)??candidates[0];
  let states=0,capped=false;
  // Field-format prior is learned from the reference, not the victim. Only ASCII phone reconstruction is attempted.
  if(codec.field==='phone'&&allAlphabet.every(c=>c.codePointAt(0)!<128)){
   const n=view.length??view.plainBytes,adjacent=known.map(p=>atoms.get(p)!).filter(a=>a.kind==='adjacent'),edges=new Map<string,string[]>(),starts=known.map(p=>atoms.get(p)!).filter(a=>a.kind==='start').map(a=>a.value),ends=known.map(p=>atoms.get(p)!).filter(a=>a.kind==='end').map(a=>a.value);
   for(const a of adjacent){const [x,y]=Array.from(a.value),ys=edges.get(x)??[];if(!ys.includes(y))ys.push(y);edges.set(x,ys);}
   const required=new Set(adjacent.map(a=>a.value)),solutions=new Set<string>();
   function walk(path:string[]){if(++states>2000){capped=true;return;}if(solutions.size>1||capped)return;if(path.length===n){const value=path.join('');if(ends.length&&!ends.includes(path.at(-1)!))return;const present=new Set(Array.from({length:n-1},(_,i)=>path[i]+path[i+1]));if([...required].every(p=>present.has(p)))solutions.add(value);return;}for(const next of edges.get(path.at(-1)!)??[]){if(path.length>1){const id=pairIds.get('skip\0'+path.at(-2)!+next);if(id&&observedAbsent(id,tokenSet))continue;}walk([...path,next]);}}
   if(n>=2&&n<=32)for(const start of starts.length?starts:[...edges.keys()])walk([start]);
   if(solutions.size===1&&!capped)return {value:[...solutions][0],source:'graph',graphStates:states,graphCapped:false};
  }
  return {value:dictionary??prior,source:dictionary?'dictionary':'prior',graphStates:states,graphCapped:capped};
 };
}
