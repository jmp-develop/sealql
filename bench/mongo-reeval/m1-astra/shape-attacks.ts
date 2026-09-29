/** Snapshot-only guesses. Public schema shape functions may tokenize strings,
 * but must never contain a PRF, occurrence counter lookup or secret key. */
export interface Shape {tags:number; bytes?:number}
export interface KnownShape {value:string;shape:Shape}
export function shapeKey(s:Shape){return JSON.stringify([s.tags,s.bytes]);}
export function shapeAttack(reference:string[],shapeOf:(value:string)=>Shape,known:KnownShape[],normalize:(value:string)=>string){
 const refCounts=new Map<string,number>(),knownCounts=new Map<string,number>();
 for(const value of reference)refCounts.set(value,(refCounts.get(value)??0)+1);
 const plainByShape=new Map<string,Map<string,number>>();
 for(const [value,n]of refCounts){const key=shapeKey(shapeOf(value)),group=plainByShape.get(key)??new Map();group.set(value,n);plainByShape.set(key,group);}
 for(const {value,shape}of known){knownCounts.set(value,(knownCounts.get(value)??0)+1);const key=shapeKey(shape),group=plainByShape.get(key)??new Map();if(!group.has(value))group.set(value,0);plainByShape.set(key,group);}
 const top=(xs:Map<string,number>)=>[...xs].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]??'';
 const prior=top(refCounts),referenceChoice=new Map<string,string>(),knownChoice=new Map<string,string>();
 for(const [key,group]of plainByShape){referenceChoice.set(key,top(group));const posterior=new Map([...group].map(([value,n])=>[value,n+(knownCounts.get(value)??0)]));knownChoice.set(key,top(posterior));}
 return {predictReference:(view:Shape)=>referenceChoice.get(shapeKey(view))??prior,predictKnown:(view:Shape)=>knownChoice.get(shapeKey(view))??prior,metadata:{referenceDistinct:new Set(reference.map(normalize)).size,shapeClasses:plainByShape.size,knownRows:known.length}};
}
export interface PublicCounter {id:string;n?:number;value?:string}
/** Exactly two endpoints, with no per-insert transaction grouping. */
export function counterDelta(before:PublicCounter[],after:PublicCounter[]){const b=new Map(before.map(x=>[x.id,x])),a=new Map(after.map(x=>[x.id,x]));const removed=[...b.keys()].filter(id=>!a.has(id)),added=after.filter(x=>!b.has(x.id)),changed=after.filter(x=>b.has(x.id)&&(x.n!==b.get(x.id)!.n||x.value!==b.get(x.id)!.value));return {removed,added,changed,deltas:after.filter(x=>x.n!==undefined).map(x=>({id:x.id,delta:x.n!-(b.get(x.id)?.n??0)})).filter(x=>x.delta!==0)};}
/** Infer anonymous counter labels from a known batch's frequency vector.
 * This does NOT identify which historical document contains a counter value. */
export function learnBatchCounterLabels(deltas:{id:string;delta:number}[],knownPieces:string[][]){const expected=new Map<string,number>();for(const ps of knownPieces)for(const p of new Set(ps))expected.set(p,(expected.get(p)??0)+1);const byCount=new Map<number,string[]>();for(const [p,n]of expected){const ps=byCount.get(n)??[];ps.push(p);byCount.set(n,ps);}return deltas.map(x=>({...x,candidates:byCount.get(x.delta)??[]}));}
