import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, integer, text, customType } from 'drizzle-orm/pg-core';
import { relations, eq, sql, like, lt } from 'drizzle-orm';
import { assertDisposable } from '../../test/disposable.js';

const pool=new pg.Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1});
const out=new URL('../results/2026-09-27-drizzle-falsify/',import.meta.url);await mkdir(out,{recursive:true});
const result:any={e2:{},e3:{},e4:{},e5:{},e6:{},cleanup:false};
const als=new AsyncLocalStorage<string>(),events:any[]=[];
const scopeType=customType<{data:string;driverData:string}>({dataType:()=> 'text',toDriver:v=>{events.push({direction:'to',scope:als.getStore(),value:v});return `enc:${v}`;},fromDriver:v=>{events.push({direction:'from',scope:als.getStore(),value:v});return String(v).replace(/^enc:/,'');}});
const s=pgSchema('drizzle_falsify');
const parent=s.table('parent',{id:integer('id').primaryKey(),scope:text('scope'),secret:scopeType('secret'),pub:text('pub')});
const child=s.table('child',{id:integer('id').primaryKey(),parentId:integer('parent_id').references(()=>parent.id),secret:scopeType('secret')});
const parentRelations=relations(parent,({many})=>({children:many(child)}));
const childRelations=relations(child,({one})=>({parent:one(parent,{fields:[child.parentId],references:[parent.id]})}));
const exactToken=(v:string)=>createHmac('sha384','poc-key').update(v).digest('hex').slice(0,2);
const pairType=customType<{data:{ct:string;plain:string};driverData:string}>({dataType:()=> 'drizzle_falsify.seal_pair',toDriver:v=>`(${v.ct},${exactToken(v.plain)})`,fromDriver:v=>v});
const pairs=s.table('pairs',{id:integer('id').primaryKey(),sealed:pairType('sealed')});
async function attempt(fn:()=>Promise<any>){try{return {ok:true,value:await fn()};}catch(e:any){return {ok:false,code:e.code??e.cause?.code,message:e.message,cause:e.cause?.message};}}
try{
 await assertDisposable(pool);assert.equal((await pool.query('show port')).rows[0].port,'56439');
 await pool.query('create schema drizzle_falsify');
 await pool.query('create table drizzle_falsify.parent(id integer primary key,scope text,secret text,pub text)');
 await pool.query('create table drizzle_falsify.child(id integer primary key,parent_id integer references drizzle_falsify.parent(id),secret text)');
 const db=drizzle({client:pool,schema:{parent,child,parentRelations,childRelations}});
 result.e2.insert=await als.run('base',()=>db.insert(parent).values({id:1,scope:'base',secret:'one',pub:'public'}).returning());
 result.e2.select=await als.run('base',()=>db.select().from(parent));
 result.e2.partial=await als.run('base',()=>db.select({secret:parent.secret}).from(parent));
 await als.run('base',()=>db.insert(child).values({id:1,parentId:1,secret:'nested'}));
 result.e2.join=await als.run('base',()=>db.select({a:parent.secret,b:child.secret}).from(parent).innerJoin(child,eq(parent.id,child.parentId)));
 result.e2.updateReturning=await als.run('base',()=>db.update(parent).set({secret:'two'}).where(eq(parent.id,1)).returning());
 result.e2.prepared=await als.run('base',()=>db.select().from(parent).where(eq(parent.id,sql.placeholder('id'))).prepare('falsify_parent').execute({id:1}));
 result.e2.relational=await als.run('base',()=>db.query.parent.findMany({with:{children:true}}));
 result.e2.transaction=await als.run('base',()=>db.transaction(async tx=>(await tx.insert(parent).values({id:2,scope:'base',secret:'tx'}).returning())[0]));
 result.e2.raw=await als.run('base',async()=>(await db.execute(sql`select secret from drizzle_falsify.parent where id=1`)).rows);
 result.e2.events=events.slice();
 // Force a one-connection queue and two overlapping request scopes.
 const hold=await pool.connect();
 const pending=['A','B'].map((scope,i)=>als.run(scope,async()=>{await db.insert(parent).values({id:10+i,scope,secret:scope}).returning();return (await db.select().from(parent).where(eq(parent.id,10+i)))[0].secret;}));
 await new Promise(resolve=>setTimeout(resolve,20));hold.release();
 result.e3.parallelQueued=await Promise.all(pending);
 result.e3.transaction=await als.run('TX',()=>db.transaction(async tx=>(await tx.insert(parent).values({id:12,scope:'TX',secret:'TX'}).returning())[0]));
 const beforeOutside=events.length;
 result.e3.thenableOutside=await als.run('OUT',()=>db.insert(parent).values({id:13,scope:'OUT',secret:'OUT'}).returning());
 result.e3.thenableOutsideEvents=events.slice(beforeOutside);
 result.e3.events=events.filter(x=>['A','B','TX'].includes(x.scope));

 await pool.query(`create table drizzle_falsify.trigger_rows(id integer primary key, scope text not null, input jsonb, ct text, tokens text[]);
 create function drizzle_falsify.unpack() returns trigger language plpgsql as $$ begin
 if new.input is not null then
   new.ct=new.input->>'ct';
   select array_agg(value order by value) into new.tokens from jsonb_array_elements_text(new.input->'tokens') as value;
   new.input=null;
 end if;
 return new; end $$;
 create trigger unpack_before before insert or update on drizzle_falsify.trigger_rows for each row execute function drizzle_falsify.unpack();`);
 const q=(text:string,values:any[]=[])=>pool.query(text,values);
 await q('insert into drizzle_falsify.trigger_rows(id,scope,input) values(1,$1,$2)', ['A',JSON.stringify({ct:'c1',tokens:['x']})]);
 result.e4.insert=(await q('select * from drizzle_falsify.trigger_rows where id=1')).rows[0];
 await q('update drizzle_falsify.trigger_rows set scope=$1 where id=1',['A']);result.e4.partial=(await q('select * from drizzle_falsify.trigger_rows where id=1')).rows[0];
 result.e4.upsert=(await q('insert into drizzle_falsify.trigger_rows(id,scope,input) values(1,$1,$2) on conflict(id) do update set input=excluded.input returning *',['A',JSON.stringify({ct:'c2',tokens:['y']})])).rows[0];
 result.e4.copy=(await q('insert into drizzle_falsify.trigger_rows(id,scope,input) select 2,scope,jsonb_build_object(\'ct\',ct,\'tokens\',to_jsonb(tokens)) from drizzle_falsify.trigger_rows where id=1 returning *')).rows[0];
 const c1=await pool.connect(); // pool max=1: use an independent client for contention below.
 c1.release();
 const p1=new pg.Client({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'}),p2=new pg.Client({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
 await Promise.all([p1.connect(),p2.connect()]);
 try{await p1.query('begin');await p1.query('update drizzle_falsify.trigger_rows set input=$1 where id=1',[JSON.stringify({ct:'c3',tokens:['z']})]);
 const second=p2.query('update drizzle_falsify.trigger_rows set input=$1 where id=1',[JSON.stringify({ct:'c4',tokens:['w']})]);
 await new Promise(resolve=>setTimeout(resolve,25));await p1.query('commit');await second;
 result.e4.concurrent=(await q('select * from drizzle_falsify.trigger_rows where id=1')).rows[0];
 await p1.query('begin');await p1.query('update drizzle_falsify.trigger_rows set input=$1 where id=1',[JSON.stringify({ct:'rollback',tokens:['bad']})]);await p1.query('rollback');
 result.e4.rollback=(await q('select * from drizzle_falsify.trigger_rows where id=1')).rows[0];
 result.e4.directColumn=(await q("update drizzle_falsify.trigger_rows set ct='raw-corrupt' where id=2 returning *")).rows[0];
 }finally{await Promise.all([p1.end(),p2.end()]);}

 await q(`create type drizzle_falsify.seal_pair as (ct text, token text);
 create function drizzle_falsify.pair_eq(a drizzle_falsify.seal_pair,b drizzle_falsify.seal_pair) returns boolean language sql immutable as $$ select (a).token=(b).token $$;
 create operator drizzle_falsify.= (leftarg=drizzle_falsify.seal_pair,rightarg=drizzle_falsify.seal_pair,procedure=drizzle_falsify.pair_eq);
 create table drizzle_falsify.pairs(id integer primary key,sealed drizzle_falsify.seal_pair);`);
 await q('set search_path=drizzle_falsify,public');
 const pairDb=drizzle({client:pool});
 let colliding='';const first='alpha', t=exactToken(first);for(let i=0;i<10000;i++){const v=`other${i}`;if(v!==first&&exactToken(v)===t){colliding=v;break;}}assert(colliding);
 await pairDb.insert(pairs).values([{id:1,sealed:{ct:'cipher1',plain:first}},{id:2,sealed:{ct:'cipher2',plain:colliding}}]);
 result.e5={first,colliding,token:t,eq:await attempt(()=>pairDb.select().from(pairs).where(eq(pairs.sealed,{ct:'probe',plain:first}))),lt:await attempt(()=>pairDb.select().from(pairs).where(lt(pairs.sealed,{ct:'probe',plain:first}))),ltCast:await attempt(async()=>(await pairDb.execute(sql`select id from drizzle_falsify.pairs where sealed < ${'(probe,a6)'}::drizzle_falsify.seal_pair`)).rows),like:await attempt(()=>pairDb.select().from(pairs).where(like(pairs.sealed as any,'%a%')))};

 await q(`create table drizzle_falsify.checked(id integer primary key,scope text not null,secret text not null,
 constraint sealed_format check(secret ~ '^sealed:[A-Za-z0-9]+:[A-Za-z0-9]+$'),
 constraint sealed_scope check(split_part(secret,':',2)=scope));`);
 result.e6.plain=await attempt(()=>q("insert into drizzle_falsify.checked values(1,'A','hello')"));
 result.e6.mismatch=await attempt(()=>q("insert into drizzle_falsify.checked values(2,'A','sealed:B:abc')"));
 result.e6.forged=await attempt(async()=>(await q("insert into drizzle_falsify.checked values(3,'A','sealed:A:fake')")).rowCount);
 result.e6.rows=(await q('select * from drizzle_falsify.checked')).rows;
 assert.deepEqual(result.e3.parallelQueued,['A','B']);assert.equal(result.e4.concurrent.ct,'c4');assert.equal(result.e4.rollback.ct,'c4');
}catch(e:any){result.error={message:e.message,stack:e.stack,code:e.code};}
finally{try{await assertDisposable(pool);await pool.query('drop schema if exists drizzle_falsify cascade');result.cleanup=true;}catch(e:any){result.cleanupError=e.message;}await pool.end();await writeFile(new URL('db.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify({error:result.error,cleanup:result.cleanup,e2:result.e2,e3:result.e3,e4:result.e4,e5:result.e5,e6:result.e6},null,2));if(result.error||!result.cleanup)process.exitCode=1;}
