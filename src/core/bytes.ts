import { ensure, fail } from './errors.js';
const encoder = new TextEncoder();
export function utf8(s: string): Uint8Array {
  ensure(typeof s === 'string');
  for (let i=0;i<s.length;i++) { const c=s.charCodeAt(i); if(c>=0xd800&&c<=0xdbff) { const d=s.charCodeAt(++i); ensure(d>=0xdc00&&d<=0xdfff); } else ensure(c<0xdc00||c>0xdfff); }
  return encoder.encode(s);
}
export function decode(b: Uint8Array): string { try { return new TextDecoder('utf-8',{fatal:true}).decode(b); } catch { return fail('INVALID_CIPHERTEXT'); } }
export function concat(...parts: Uint8Array[]): Uint8Array { const r=new Uint8Array(parts.reduce((n,p)=>n+p.length,0)); let o=0; for(const p of parts){r.set(p,o);o+=p.length;}return r; }
export function u32(n: number): Uint8Array { ensure(Number.isInteger(n)&&n>=0&&n<=0xffffffff); const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n);return b; }
export function frame(parts: (string|Uint8Array)[]): Uint8Array { const p=parts.map(x=>typeof x==='string'?utf8(x):x);return concat(u32(p.length),...p.flatMap(x=>[u32(x.length),x])); }
export function compare(a: Uint8Array,b: Uint8Array): number { for(let i=0;i<Math.min(a.length,b.length);i++)if(a[i]!==b[i])return a[i]-b[i];return a.length-b.length; }
export function compareText(a:string,b:string):number{return compare(utf8(a),utf8(b));}
export function canonical(value: unknown, seen = new Set<object>()): Uint8Array {
  if(value===null)return frame(['null']);
  if(typeof value==='boolean')return frame(['bool',new Uint8Array([+value])]);
  if(typeof value==='string')return frame(['str',utf8(value)]);
  if(typeof value==='bigint')return frame(['int',value.toString()]);
  if(typeof value==='number'){ensure(Number.isFinite(value));const b=new Uint8Array(8);new DataView(b.buffer).setFloat64(0,Object.is(value,-0)?0:value);return frame(['num',b]);}
  if(value instanceof Uint8Array)return frame(['bytes',value]);
  if(value instanceof Date){ensure(Number.isFinite(value.getTime()));return frame(['date',value.toISOString()]);}
  if(typeof value==='object'){
    ensure(!seen.has(value));seen.add(value);
    try {
      if(Array.isArray(value))return frame(['array',...value.map(v=>canonical(v,seen))]);
      ensure(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
      ensure(Object.getOwnPropertySymbols(value).length===0);
      const o=value as Record<string,unknown>;
      return frame(['object',...Object.keys(o).sort((a,b)=>compare(utf8(a),utf8(b))).map(k=>frame([k,canonical(o[k],seen)]))]);
    } finally {seen.delete(value);}
  }
  return fail('INVALID_VALUE');
}
export function hex(b: Uint8Array): string { return Array.from(b,x=>x.toString(16).padStart(2,'0')).join(''); }
export function unhex(s: string): Uint8Array {ensure(/^(?:[0-9a-f]{2})*$/.test(s));return Uint8Array.from(s.match(/../g)??[],x=>parseInt(x,16));}
export function base64url(b: Uint8Array): string {let s='';for(const n of b)s+=String.fromCharCode(n);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function unbase64url(s: string, max=Infinity): Uint8Array {ensure(typeof s==='string'&&s.length<=Math.ceil(max*4/3)&&/^[A-Za-z0-9_-]*$/.test(s));let b:Uint8Array;try{b=Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),x=>x.charCodeAt(0));}catch{return fail('INVALID_VALUE');}ensure(b.length<=max&&base64url(b)===s);return b;}
export function decodeRootKey(s:string):Uint8Array{const b=unbase64url(s,32);ensure(b.length===32);return b;}
export function identity(s:string,type:'uuid'|'text'):string{const b=utf8(s);ensure(b.length>0&&b.length<=1024&&!s.includes('\0'),'INVALID_ID');if(type==='uuid')ensure(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s),'INVALID_ID');return s;}
export function freeze<T>(v:T):T {if(v&&typeof v==='object'&&!(v instanceof Uint8Array)){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
