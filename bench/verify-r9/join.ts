import {and,eq} from 'drizzle-orm';
import {acquire,release,connect,model,save,archive,fields,sealed,scope,assert,drizzle,normalize,measured,summarize,readFileSync,OUT} from './common.js';
import {tickets,ticketsSeal} from './join-schema.js';

const h=model('test_r9_verify_main'),paths=['plain','product'] as const;
acquire();const pool=await connect(),db=drizzle(pool),result:any={started:new Date().toISOString(),condition:'tickets.memo contains "서비스" AND customers.company = "서울서비스 담당"',rows:[],errors:[],complete:false};
archive('join');
try{
 assert.equal(JSON.parse(readFileSync(`${OUT}/ticket-load.json`,'utf8')).complete,true);
 result.commit=JSON.parse(readFileSync(`${OUT}/install.json`,'utf8')).commit;
 result.session=(await pool.query('select pg_backend_pid() pid')).rows[0];
 const customerSource=(await pool.query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers where scope_id=$1`,[scope])).rows;
 const customers=new Map(customerSource.map(r=>[r.id,r]));
 const ticketSource=(await pool.query('select id,customer_id,memo_plain from bench_realistic_100k.tickets where scope_id=$1 order by id',[scope])).rows;
 const truth=ticketSource.filter(t=>normalize(t.memo_plain).includes('서비스')&&normalize(customers.get(t.customer_id).company)===normalize('서울서비스 담당')).map(t=>({id:t.id,customerId:t.customer_id,ticketMemo:normalize(t.memo_plain),...Object.fromEntries(fields.map(f=>[f,normalize(customers.get(t.customer_id)[f])]))}));
 result.matches=truth.length;
 for(const limit of [20,300]){
  const expected=truth.slice(0,limit),record:any={limit,returned:expected.length,first:{},runs:{plain:[],product:[]},summary:{},sql:{}};
  const plain=async()=> (await pool.query(`select t.id,t.customer_id as "customerId",t.memo_norm as "ticketMemo",${fields.map(f=>`c.${f}_norm as ${f}`).join(',')} from bench_realistic_100k.tickets t join research_u.customers_plain c on c.id=t.customer_id and c.scope_id=t.scope_id where t.scope_id=$1 and t.memo_norm like $2 and c.company_norm=$3 order by t.id limit $4`,[scope,'%서비스%',normalize('서울서비스 담당'),limit])).rows;
  const product=async()=> (await sealed.search(db,{scope,limit,
   match:{t:[ticketsSeal,m=>m.memo.contains('서비스')],c:[h.seal,(m:any)=>m.company.eq('서울서비스 담당')]},
   query:({where,after,orderBy,flags,limit}:any)=>db.select({t:tickets,c:h.table,...flags}).from(tickets).innerJoin(h.table,and(eq(tickets.customerId,h.table.id),eq(tickets.scopeId,h.table.scopeId))).where(and(where,after)).orderBy(...orderBy).limit(limit),
  } as any)).items;
  for(let round=-3;round<7;round++)for(const path of (round+3)%2?[...paths].reverse():paths){
   const out=await measured(path==='plain'?plain:product);assert.deepEqual(out.pids,[result.session.pid]);
   const value=path==='plain'?out.value:out.value.map((r:any)=>({id:r.t.id,customerId:r.t.customerId,ticketMemo:normalize(r.t.memo),...Object.fromEntries(fields.map(f=>[f,normalize(r.c[f])]))}));
   assert.deepEqual(value,expected,`JOIN ${limit} ${path}`);
   if(path==='product'){const expectedOpens=expected.length+new Set(expected.map(r=>r.customerId)).size*6;assert.equal(out.metric.opens,expectedOpens);}
   if(round===-3){record.first[path]=out.metric;record.sql[path]=out.sql;}if(round>=0)record.runs[path].push(out.metric);
  }
  for(const path of paths)record.summary[path]=summarize(record.runs[path]);result.rows.push(record);save('join',result);console.log(JSON.stringify({limit,summary:record.summary}));
 }
 result.complete=true;result.finished=new Date().toISOString();save('join',result);
}catch(error){result.errors.push({message:String(error)});save('join',result);throw error;}finally{await pool.end();release();}
