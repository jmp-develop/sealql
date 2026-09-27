import { canonical } from './bytes.js';
import { ensure } from './errors.js';
export type Node={kind:'literal';text:string}|{kind:'identifier';names:string[]}|{kind:'param';value:unknown}|{kind:'concat';nodes:Node[]};
export class Fragment {constructor(readonly node:Node){Object.freeze(this);} }
export function pgsql(strings:TemplateStringsArray,...values:unknown[]):Fragment {ensure(Array.isArray(strings.raw),'INVALID_QUERY');return join(strings.flatMap((s,i)=>i<values.length?[literal(s),values[i] instanceof Fragment?values[i] as Fragment:param(values[i])]:[literal(s)]));}
export function column(...names:string[]):Fragment{ensure(names.length>0&&names.every(s=>typeof s==='string'&&s.length>0&&!s.includes('\0')),'INVALID_SCHEMA');return new Fragment({kind:'identifier',names:[...names]});}
export function param(value:unknown):Fragment{canonical(value);return new Fragment({kind:'param',value:structuredClone(value)});}
export function literal(text:string):Fragment{return new Fragment({kind:'literal',text});}
export function join(parts:Fragment[],separator=''):Fragment{return new Fragment({kind:'concat',nodes:parts.flatMap((p,i)=>i?[{kind:'literal',text:separator} as Node,p.node]:[p.node])});}
