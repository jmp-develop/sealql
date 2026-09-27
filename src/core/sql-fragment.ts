import { canonical } from './bytes.js';
import { ensure } from './errors.js';
export type Node={kind:'literal';text:string}|{kind:'identifier';names:string[]}|{kind:'param';value:unknown}|{kind:'concat';nodes:Node[]}|{kind:'native';value:unknown};
export class Fragment {constructor(readonly node:Node){Object.freeze(this);} compile():Statement{return render(this);} }
export interface Statement {text:string;values:unknown[]}
export function pgsql(strings:TemplateStringsArray,...values:unknown[]):Fragment {ensure(Array.isArray(strings.raw),'INVALID_QUERY');return join(strings.flatMap((s,i)=>i<values.length?[literal(s),values[i] instanceof Fragment?values[i] as Fragment:param(values[i])]:[literal(s)]));}
export function column(...names:string[]):Fragment{ensure(names.length>0&&names.every(s=>typeof s==='string'&&s.length>0&&!s.includes('\0')&&s.length<=128),'INVALID_SCHEMA');return new Fragment({kind:'identifier',names:[...names]});}
export function param(value:unknown):Fragment{canonical(value);return new Fragment({kind:'param',value:structuredClone(value)});}
export function literal(text:string):Fragment{return new Fragment({kind:'literal',text});}
export function join(parts:Fragment[],separator=''):Fragment{return new Fragment({kind:'concat',nodes:parts.flatMap((p,i)=>i?[{kind:'literal',text:separator} as Node,p.node]:[p.node])});}
export function render(fragment:Fragment):Statement{const values:unknown[]=[];const walk=(n:Node):string=>{switch(n.kind){case'literal':return n.text;case'identifier':return n.names.map(s=>'"'+s.replace(/"/g,'""')+'"').join('.');case'param':values.push(n.value);return '$'+values.length;case'concat':return n.nodes.map(walk).join('');case'native':throw new Error('INVALID_QUERY');}};return {text:walk(fragment.node),values};}
