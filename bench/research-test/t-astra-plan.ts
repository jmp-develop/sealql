import {S,pool,scope,fields,lock,unlock,save,candidateWhere,verifyWhere,type Tree} from './t-astra-common.js';
const out:any[]=[];
const capture=async(name:string,query:string,params:any[])=>out.push({name,query,mode:'EXPLAIN only, no execution timing; coordinator-authorized lock exception',plan:(await pool.query('explain (format json) '+query,params)).rows[0]['QUERY PLAN']});
try{await lock();
for(const [name,tree] of [['rare',{field:'memo',op:'contains',value:'푸른달'}],['broad',{field:'memo',op:'contains',value:'서비스'}],['exact',{field:'company',op:'eq',value:'서울서비스 담당'}]] as [string,Tree][]){
 const ps:any[]=[scope],pre=await candidateWhere(tree,'customers',ps),ver=verifyWhere(tree,'customers',ps);
 await capture(name,`select count(*) from ${S}.customers_seal_index i join ${S}.customers_tags j on j.id=i.row_id where i.scope_id=$1 and ${pre} and ${ver}`,ps);
 if(name==='broad')for(const limit of [20,200])await capture('find'+limit,`select p.id,p.scope_id,${fields.map(f=>`p.${f}_ct ${f}`).join(',')} from ${S}.customers_seal_index i join ${S}.customers_tags j on j.id=i.row_id join ${S}.customers p on p.id=i.row_id where i.scope_id=$1 and ${pre} and ${ver} order by p.id limit ${limit}`,ps);
}
const ps:any[]=[scope],t:Tree={field:'memo',op:'contains',value:'서비스'},c:Tree={field:'company',op:'eq',value:'서울서비스 담당'};
const preT=await candidateWhere(t,'tickets',ps),verT=verifyWhere(t,'tickets',ps),preC=await candidateWhere(c,'customers',ps,'ci'),verC=verifyWhere(c,'customers',ps,'cj');
const from=`${S}.tickets_seal_index i join ${S}.tickets_tags j on j.id=i.row_id join ${S}.tickets p on p.id=i.row_id join ${S}.customers c on c.id=p.customer_id join ${S}.customers_seal_index ci on ci.row_id=c.id and ci.scope_id=i.scope_id join ${S}.customers_tags cj on cj.id=c.id`;
const where=`i.scope_id=$1 and ${preT} and ${verT} and ${preC} and ${verC}`;
await capture('joinCount',`select count(*) from ${from} where ${where}`,ps);
await capture('join20',`select p.id,p.scope_id,c.id c_id,c.scope_id c_scope_id,${fields.flatMap(f=>[`p.${f}_ct t_${f}`,`c.${f}_ct c_${f}`]).join(',')} from ${from} where ${where} order by p.id limit 20`,ps);
save('plan',out);
}finally{unlock();await pool.end();}
