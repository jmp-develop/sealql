import {Client} from 'pg';
import {assert,median} from './common.js';
export type Statement={text:string;values:any[]};
export type Rewrite=(statement:Statement)=>Statement;
type Event={start:number;end:number;rows:number;pid:number;statement:Statement};
let active:Event[]|undefined,rewrite:Rewrite|undefined,opens=0;
export let lastSQL:{text:string;parameterCount:number}|undefined;
export function instrumentSealer(sealer:any){const original=sealer.open;sealer.open=function(...args:any[]){if(active)opens++;return original.apply(this,args);};}
const query=Client.prototype.query;
(Client.prototype as any).query=function(...input:any[]){
 const args=[...input],capture=active;let statement:Statement={text:typeof args[0]==='string'?args[0]:args[0]?.text??'',values:Array.isArray(args[1])?args[1]:typeof args[0]==='string'?[]:args[0]?.values??[]};
 if(capture&&rewrite){statement=rewrite(statement);if(typeof args[0]==='string'){args[0]=statement.text;if(Array.isArray(args[1]))args[1]=statement.values;else args.splice(1,0,statement.values);}else {args[0]={...args[0],text:statement.text,values:statement.values};if(Array.isArray(args[1]))args[1]=statement.values;}}
 const start=performance.now(),pid=this.processID;let done=false;
 if(capture)lastSQL={text:statement.text,parameterCount:statement.values.length};
 const record=(r:any)=>{if(!done){done=true;capture?.push({start,end:performance.now(),rows:r?.rows?.length??0,pid,statement});}return r;};
 const index=args.findIndex(a=>typeof a==='function');if(index>=0){const cb=args[index];args[index]=(error:any,r:any)=>{record(r);cb(error,r);};}
 const result=(query as any).apply(this,args);return index<0&&result?.then?result.then(record,(e:any)=>{record(undefined);throw e;}):result;
};
export async function measured(fn:()=>Promise<any>,transform?:Rewrite){
 assert.equal(active,undefined);active=[];rewrite=transform;opens=0;const start=performance.now();
 try{const value=await fn(),end=performance.now(),events=active.sort((a,b)=>a.start-b.start);let wall=0,right=-Infinity;for(const e of events){wall+=Math.max(0,e.end-Math.max(right,e.start));right=Math.max(right,e.end);}
 const pre=events.length?events[0].start-start:end-start,post=events.length?end-right:0;
 return {value,metric:{preMs:pre,sqlMs:events.reduce((s,e)=>s+e.end-e.start,0),betweenMs:Math.max(0,end-start-pre-wall-post),postMs:post,totalMs:end-start,sqlCalls:events.length,appRows:events.reduce((s,e)=>s+e.rows,0),opens},pids:[...new Set(events.map(e=>e.pid))],queries:events.map(e=>e.statement)};
 }finally{active=undefined;rewrite=undefined;}
}
export function summarize(runs:any[]){assert.equal(runs.length,7);return Object.fromEntries(Object.keys(runs[0]).map(k=>[k,median(runs.map(r=>r[k]))]));}
