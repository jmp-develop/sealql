import assert from 'node:assert/strict';
import {and,eq} from 'drizzle-orm';
import {S,pool,db,scope,fields,sealed,entry,customers,tickets,lock,unlock,save,measured,summary,match,condition,plainWhere,candidateWhere,verifyWhere,type Tree} from './t-astra-common.js';
const L=(field:string,op:any,value:string):Tree=>({field,op,value});
const broad=L('memo','contains','서비스'),rare=L('memo','contains','푸른달'),company=L('company','eq','서울서비스 담당');
type Case={name:string;tree:Tree;mode:'count'|'find'|'sum'|'joinCount'|'joinFind';limit?:number;table?:string};
const cases:Case[]=[
 {name:'exact',tree:company,mode:'count'}, {name:'contains2',tree:L('company','contains','서비'),mode:'count'},
 {name:'contains',tree:broad,mode:'count'}, {name:'rare',tree:rare,mode:'count'},
 {name:'zero',tree:L('memo','contains','없는표식'),mode:'count'},
 {name:'structuralZero',tree:L('company','contains','지사담'),mode:'count'},
 {name:'starts',tree:L('company','startsWith','서울'),mode:'count'}, {name:'ends',tree:L('company','endsWith','담당'),mode:'count'},
 {name:'and2',tree:{all:[company,broad]},mode:'count'}, {name:'or2',tree:{any:[company,rare]},mode:'count'},
 {name:'nested',tree:{all:[{any:[company,rare]},broad]},mode:'count'},
 {name:'find20',tree:broad,mode:'find',limit:20}, {name:'find200',tree:broad,mode:'find',limit:200}, {name:'findAllRare',tree:rare,mode:'find'},
 {name:'findAllBroad',tree:broad,mode:'find'},
 {name:'joinCount',tree:broad,mode:'joinCount'}, {name:'join20',tree:broad,mode:'joinFind',limit:20},
 {name:'sumTickets',tree:broad,mode:'sum',table:'tickets'},
 {name:'longReal',tree:L('memo','contains','상세 안내와 확인 내용 상세 안내와'),mode:'count'},
];
const columns=Object.fromEntries(fields.map(f=>[f,true]));
const rowFlat=(r:any)=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,r[f]]))});
const joinFlat=(r:any)=>({id:r.t.id,...Object.fromEntries(fields.flatMap(f=>[[`t_${f}`,r.t[f]],[`c_${f}`,r.c[f]]]))});
async function plain(c:Case){const ps:any[]=[scope],w=plainWhere(c.tree,ps,'p'),isjoin=c.mode.startsWith('join');let from=`${S}.${c.table??'customers'}_plain p`,where=`p.scope_id=$1 and ${w}`;
if(isjoin){from=`${S}.tickets_plain p join ${S}.customers_plain c on c.id=p.customer_id and c.scope_id=p.scope_id`;where+=` and ${plainWhere(company,ps,'c')}`;}
const projection=c.mode==='count'||c.mode==='joinCount'?'count(*)::int n':c.mode==='sum'?'coalesce(sum(p.amount),0)::text n':isjoin?`p.id,${fields.flatMap(f=>[`p.${f}_plain t_${f}`,`c.${f}_plain c_${f}`]).join(',')}`:`p.id,${fields.map(f=>`p.${f}_plain ${f}`).join(',')}`;
const rows=(await pool.query(`select ${projection} from ${from} where ${where}${c.mode==='find'||c.mode==='joinFind'?` order by p.id${c.limit?' limit '+c.limit:''}`:''}`,ps)).rows;return c.mode==='count'||c.mode==='joinCount'?Number(rows[0].n):c.mode==='sum'?rows[0].n:rows;}
async function product(c:Case){const e=entry(c.table??'customers');if(c.mode==='count')return sealed.count(db,e.seal,{scope,match:(m:any)=>match(c.tree,m)} as any);
if(c.mode==='sum'){const r=await sealed.findMany(db,e.seal,{scope,match:(m:any)=>match(c.tree,m),columns:{}} as any);assert(!r.nextCursor,'sum must consume all matches');return (await pool.query(`select coalesce(sum(amount),0)::text n from ${S}.tickets_plain where id=any($1::uuid[])`,[r.items.map((x:any)=>x.id)])).rows[0].n;}
if(c.mode==='find'){const r=await sealed.findMany(db,e.seal,{scope,match:(m:any)=>match(c.tree,m),columns,...(c.limit?{limit:c.limit}:{})} as any);assert(!r.nextCursor||!!c.limit,'all fetch incomplete');return r.items.map(rowFlat);}
const countOnly=c.mode==='joinCount';const r=await sealed.search(db,{scope,match:{t:[tickets.seal,(m:any)=>match(c.tree,m)],c:[customers.seal,(m:any)=>match(company,m)]},...(c.limit?{limit:c.limit}:{}),query:({where,after,orderBy,flags,limit}:any)=>db.select({t:countOnly?{id:tickets.table.id,scopeId:tickets.table.scopeId,memo:tickets.table.memo}:tickets.table,c:countOnly?{id:customers.table.id,scopeId:customers.table.scopeId,company:customers.table.company}:customers.table,...flags}).from(tickets.table).innerJoin(customers.table,eq(tickets.table.customerId,customers.table.id)).where(and(where,after)).orderBy(...orderBy).limit(limit)} as any);assert(!r.nextCursor||!!c.limit,'all join incomplete');return countOnly?r.items.length:r.items.map(joinFlat);}
async function candidate(c:Case,onlyCandidates=false){const isjoin=c.mode.startsWith('join'),t=isjoin?'tickets':c.table??'customers',ps:any[]=[scope];let from=`${S}.${t}_seal_index i join ${S}.${t}_tags j on j.id=i.row_id`,where=`i.scope_id=$1 and ${await candidateWhere(c.tree,t,ps)}`;if(!onlyCandidates)where+=` and ${verifyWhere(c.tree,t,ps)}`;
if(isjoin){from+=` join ${S}.tickets p on p.id=i.row_id join ${S}.customers c on c.id=p.customer_id join ${S}.customers_seal_index ci on ci.row_id=c.id and ci.scope_id=i.scope_id join ${S}.customers_tags cj on cj.id=c.id`;where+=` and ${await candidateWhere(company,'customers',ps,'ci')}`;if(!onlyCandidates)where+=` and ${verifyWhere(company,'customers',ps,'cj')}`;}
if(onlyCandidates)return Number((await pool.query(`select count(*)::int n from ${from} where ${where}`,ps)).rows[0].n);
if(c.mode==='count'||c.mode==='joinCount')return Number((await pool.query(`select count(*)::int n from ${from} where ${where}`,ps)).rows[0].n);
if(c.mode==='sum'){from+=` join ${S}.tickets_plain p on p.id=i.row_id`;return (await pool.query(`select coalesce(sum(p.amount),0)::text n from ${from} where ${where}`,ps)).rows[0].n;}
if(!isjoin)from+=` join ${S}.${t} p on p.id=i.row_id`;
const projection=isjoin?`p.id,p.scope_id,c.id c_id,c.scope_id c_scope_id,${fields.flatMap(f=>[`p.${f}_ct t_${f}`,`c.${f}_ct c_${f}`]).join(',')}`:`p.id,p.scope_id,${fields.map(f=>`p.${f}_ct ${f}`).join(',')}`;
let rows=(await pool.query(`select ${projection} from ${from} where ${where} order by p.id${c.limit?' limit '+c.limit:''}`,ps)).rows;
if(isjoin){rows=await sealed.openRaw(tickets.seal,rows,{scope,columns:{id:'id',scopeId:'scope_id',...Object.fromEntries(fields.map(f=>[f,'t_'+f]))}});rows=await sealed.openRaw(customers.seal,rows,{scope,columns:{id:'c_id',scopeId:'c_scope_id',...Object.fromEntries(fields.map(f=>[f,'c_'+f]))}});return rows.map(r=>({id:r.id,...Object.fromEntries(fields.flatMap(f=>[[`t_${f}`,r['t_'+f]],[`c_${f}`,r['c_'+f]]]))}));}
rows=await sealed.openRaw(entry(t).seal,rows,{scope,columns:{id:'id',scopeId:'scope_id',...Object.fromEntries(fields.map(f=>[f,f]))}});return rows.map(rowFlat);}
const report:any={started:new Date().toISOString(),rowsPerTable:100000,warmups:2,repetitions:7,tagBits:64,K:8,tagFields:['memo','company'],sum:'char_length(ticket.memo_plain), derived plaintext integer, not financial amount',cases:[],failures:[]};
try{await lock();report.locale=(await pool.query('select datcollate from pg_database where datname=current_database()')).rows[0];
for(const c of cases){try{const expected=await plain(c);const countsCase={...c,mode:c.mode.startsWith('join')?'joinCount':'count',limit:undefined} as Case;const matches=await plain(countsCase),dbCandidates=await candidate(c,true);const methods={plain:()=>plain(c),product:()=>product(c),A:()=>candidate(c)};const runs:any={plain:[],product:[],A:[]};const first:any={};
for(let i=-3;i<7;i++)for(const path of (i%2?['A','product','plain']:['plain','product','A']) as (keyof typeof methods)[]){const result=await measured(methods[path]);assert.deepEqual(result.value,expected,`${c.name}/${path}/${i}`);const {value,...stats}=result;if(i===-3)first[path]=stats;if(i>=0)runs[path].push(stats);}
const row={...c,condition:c.mode.startsWith('join')?'ticket.'+condition(c.tree)+' AND customer.'+condition(company):condition(c.tree),targetRows:100000,actualMatches:matches,resultRows:Array.isArray(expected)?expected.length:1,resultValue:Array.isArray(expected)?undefined:expected,dbCandidates,first,summary:Object.fromEntries(Object.entries(runs).map(([name,xs])=>[name,summary(xs as any[])])),runs};report.cases.push(row);save('measure',report);console.log(JSON.stringify({name:c.name,matches,dbCandidates,summary:row.summary}));
}catch(e:any){report.failures.push({case:c.name,error:e.stack});save('measure',report);console.error('FAILED',c.name,e.message);break;}}
report.finished=new Date().toISOString();save('measure',report);
}finally{unlock();await pool.end();}
