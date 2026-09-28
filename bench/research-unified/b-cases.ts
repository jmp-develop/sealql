import {cases, condition, type Node} from '../verify-native/r8-cases.js';
export type BCase={name:string;node:Node;mode:'count'|'find'|'joinCount'|'joinFind'|'sum';limit?:number;sourceRespectWords?:boolean};
const pick=(name:string):Node=>{const found=cases.find(c=>c.name===name);if(!found)throw Error(name);return found.node;};
export const broad:Node={field:'memo',op:'contains',value:'서비스'};
export const company=pick('exact_common');
export const B_CASES:BCase[]=[
  ...cases.map(c=>({name:c.name,node:c.node,mode:'count' as const,sourceRespectWords:c.respectWords})),
  {name:'sub_common_memo',node:broad,mode:'count'},
  {name:'or_and_mix',node:{any:[pick('and2'),pick('sub_rare')]},mode:'count'},
  ...['exact_common','sub_rare','starts','and2','or2','and6'].flatMap(name=>[20,200,undefined].map(limit=>({name:`${name}_list_${limit??'all'}`,node:pick(name),mode:'find' as const,...(limit?{limit}:{})}))),
  {name:'join_count',node:broad,mode:'joinCount'},
  {name:'join_list_20',node:broad,mode:'joinFind',limit:20},
  {name:'sum',node:broad,mode:'sum'},
  // A known correctness counterexample goes last: no performance repeats after mismatch.
  {name:'sub45',node:{field:'memo',op:'contains',value:'상세안내와확인내용'.repeat(5)},mode:'count'},
];
export const describe=(c:BCase)=>c.mode.startsWith('join')?'ticket.'+condition(c.node)+' AND customer.'+condition(company):condition(c.node);
