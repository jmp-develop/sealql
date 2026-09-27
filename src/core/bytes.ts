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
export function canonical(value: unknown): Uint8Array {
  const active = new Set<object>();
  const results: Uint8Array[] = [];
  const stack: ({ value: unknown } | { object: object; keys: string[] | null })[] = [{ value }];
  while (stack.length) {
    const task = stack.pop()!;
    if ('object' in task) {
      const count = task.keys?.length ?? (task.object as unknown[]).length;
      const children = results.splice(results.length - count, count);
      results.push(task.keys === null ? frame(['array', ...children])
        : frame(['object', ...children.map((child, index) => frame([task.keys![index], child]))]));
      active.delete(task.object);
      continue;
    }
    const item = task.value;
    if(item===null){results.push(frame(['null']));continue;}
    if(typeof item==='boolean'){results.push(frame(['bool',new Uint8Array([+item])]));continue;}
    if(typeof item==='string'){results.push(frame(['str',utf8(item)]));continue;}
    if(typeof item==='bigint'){results.push(frame(['int',item.toString()]));continue;}
    if(typeof item==='number'){ensure(Number.isFinite(item));const b=new Uint8Array(8);new DataView(b.buffer).setFloat64(0,Object.is(item,-0)?0:item);results.push(frame(['num',b]));continue;}
    if(item instanceof Uint8Array){results.push(frame(['bytes',item]));continue;}
    if(item instanceof Date){ensure(Number.isFinite(item.getTime()));results.push(frame(['date',item.toISOString()]));continue;}
    if(typeof item==='object'){
      ensure(!active.has(item));active.add(item);
      if(Array.isArray(item)) {
        stack.push({object:item,keys:null});
        for(let i=item.length-1;i>=0;i--)stack.push({value:item[i]});
      } else {
        ensure(Object.getPrototypeOf(item)===Object.prototype||Object.getPrototypeOf(item)===null);
        ensure(Object.getOwnPropertySymbols(item).length===0);
        const keys=Object.keys(item).sort((a,b)=>compare(utf8(a),utf8(b)));
        stack.push({object:item,keys});
        for(let i=keys.length-1;i>=0;i--)stack.push({value:(item as Record<string,unknown>)[keys[i]]});
      }
      continue;
    }
    return fail('INVALID_VALUE');
  }
  return results[0];
}
export function hex(b: Uint8Array): string { return Array.from(b,x=>x.toString(16).padStart(2,'0')).join(''); }
export function unhex(s: string): Uint8Array {ensure(/^(?:[0-9a-f]{2})*$/.test(s));return Uint8Array.from(s.match(/../g)??[],x=>parseInt(x,16));}
export function base64url(b: Uint8Array): string {let s='';for(const n of b)s+=String.fromCharCode(n);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function unbase64url(s: string, max=Infinity): Uint8Array {ensure(typeof s==='string'&&s.length<=Math.ceil(max*4/3)&&/^[A-Za-z0-9_-]*$/.test(s));let b:Uint8Array;try{b=Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),x=>x.charCodeAt(0));}catch{return fail('INVALID_VALUE');}ensure(b.length<=max&&base64url(b)===s);return b;}
export function identity(s:string,type:'uuid'|'text'):string{utf8(s);ensure(!s.includes('\0'),'INVALID_ID');if(type==='uuid')ensure(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s),'INVALID_ID');return s;}
