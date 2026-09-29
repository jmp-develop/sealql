import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { registrationOf } from '../src/adapters/drizzle/v0.45/native.js';
import { assertDisposable } from './disposable.js';
import { installProofColumns } from './proof-schema.js';
import { stamp } from '../src/core/search-stamps.js';

const fold = (value: string) => value.normalize('NFC').replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0)-0xff01+0x21)).replace(/[A-Z]/g,c=>c.toLowerCase());
const words = (value: string) => fold(value).replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g,' ').trim();
const compact = (value: string) => words(value).replaceAll(' ','');
const escaped = (value: string) => value.replace(/[\\%_]/g, c => `\\${c}`);
function like(value: string, pattern: string): boolean {
  let expression = '^', literal = '';
  const flush = () => { expression += compact(literal).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); literal = ''; };
  for (let i=0;i<pattern.length;i++) {
    if (pattern[i] === '\\') literal += pattern[++i];
    else if (pattern[i] === '%' || pattern[i] === '_') { flush(); expression += pattern[i] === '%' ? '[\\s\\S]*' : '[\\s\\S]'; }
    else literal += pattern[i];
  }
  flush(); return new RegExp(expression+'$','u').test(compact(value));
}

test('DB proofs match plaintext across operators, types, nulls, mutations and JOIN projections', async () => {
  const pool = new Pool({ host:'127.0.0.1', port:56439, user:'sealql_test', database:'postgres' });
  const schemaName = `test_r9_${process.pid}`; let created = false;
  try {
    await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
    const fixture = (await pool.query('select id,scope_id,memo_plain,name_plain from bench_realistic_100k.customers order by id limit 17')).rows;
    assert.equal(fixture.length,17);
    assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1',[schemaName])).rowCount,0);
    await pool.query(`create schema "${schemaName}"`); created = true;
    const cipher = createSealer({key:new Uint8Array(32).fill(39)}), sealed = createSealed({sealer:cipher});
    const table = pgSchema(schemaName).table('rows', { id:uuid('id').primaryKey(), scopeId:uuid('scope_id').notNull(),
      body:sealed.text('body',{nullable:true,search:{exact:true,substring:true}}),
      nfc:sealed.text('nfc',{search:{exact:true,substring:true,normalizer:'nfc-v1'}}),
      phone:sealed.text('phone',{search:{exact:true,substring:true,normalizer:'phone-v1'}}),
      amount:sealed.integer('amount',{search:{exact:{bits:2}}}), big:sealed.bigint('big',{search:{exact:true}}),
      price:sealed.decimal('price',{precision:12,scale:2,search:{exact:true}}),
    });
    const seal=sealed.register(table,{row:'id',scope:'scopeId'}), reg=registrationOf(seal), scope=fixture[0].scope_id;
    await pool.query(`create table "${schemaName}".rows(id uuid primary key,scope_id uuid not null,body_ct bytea,nfc_ct bytea not null,phone_ct bytea not null,amount_ct bytea not null,big_ct bytea not null,price_ct bytea not null)`);
    const tokenColumns=Object.values(reg.storage.index!.profiles!).map(p=>`"${p.tokens}" bigint[]`).join(',');
    await pool.query(`create table "${schemaName}".rows_seal_index(scope_id uuid not null,row_id uuid not null,${tokenColumns},unique(scope_id,row_id),foreign key(row_id) references "${schemaName}".rows(id) on delete cascade)`);
    await installProofColumns(pool,seal);
    const base=fixture[0].memo_plain as string, chars=Array.from(compact(base)), pair=chars.slice(0,2).join(''), single=chars.at(-1)!;
    const bodies:(string|null)[]=[base,base.repeat(3),null,'',chars[0],`${pair}%${single}_${pair}\\`,`${pair} ${single} ${pair}`,`${pair}${single}${pair}`,base.normalize('NFD'),`${pair}   ${single}`,base.slice(0,45),`${pair}😀${single}`,`${pair}\\${single}`,fixture[1].memo_plain,fixture[2].memo_plain,fixture[3].memo_plain];
    const inputs=fixture.slice(0,16).map((r,i)=>({id:r.id as string,scopeId:scope,body:bodies[i],nfc:` ${r.name_plain} `,
      phone:`+(${String(i+10)})-${String(r.name_plain.length).padStart(4,'0')}`,amount:r.name_plain.length as number,
      big:BigInt(r.name_plain.length),price:`${r.name_plain.length}.00`}));
    let tokenPredicates=0;
    const logs:string[]=[];const db=drizzle(pool,{logger:{logQuery(query,params){
      logs.push(query);
      for(const match of query.matchAll(/@> \$(\d+)::bigint\[\]/g)){
        const tokens=params[Number(match[1])-1];
        assert.ok(typeof tokens==='string'&&/^\{-?\d+(,-?\d+){0,2}\}$/.test(tokens),'every transmitted candidate predicate uses at most three tokens');
        tokenPredicates++;
      }
    }}});
    await sealed.insert(db,seal,inputs);
    const otherScope=fixture[16].id as string;
    assert.notEqual(otherScope,scope);
    const other={...inputs[0],id:fixture[16].id as string,scopeId:otherScope};
    await sealed.insert(db,seal,other);
    let opens=0;const original=cipher.open.bind(cipher);cipher.open=async(...args)=>{opens++;return original(...args);};
    const cases:[string,(m:any)=>any,(value:string)=>boolean][]=[
      ['eq',m=>m.body.eq(base),v=>compact(v)===compact(base)],
      ['empty eq',m=>m.body.eq(''),v=>compact(v)===''],
      ['single eq',m=>m.body.eq(chars[0]),v=>compact(v)===chars[0]],
      ['contains',m=>m.body.contains(pair),v=>compact(v).includes(pair)],
      ['long contains',m=>m.body.contains(base),v=>compact(v).includes(compact(base))],
      ['starts',m=>m.body.startsWith(pair),v=>compact(v).startsWith(pair)],
      ['ends',m=>m.body.endsWith(pair),v=>compact(v).endsWith(pair)],
      ['zero',m=>m.body.contains(base.repeat(4)),v=>compact(v).includes(compact(base.repeat(4)))],
      ['45',m=>m.body.contains(base.slice(0,45)),v=>compact(v).includes(compact(base.slice(0,45)))],
      ['nested',m=>m.or(m.and(m.body.contains(pair),m.body.endsWith(pair)),m.body.eq(base)),v=>(compact(v).includes(pair)&&compact(v).endsWith(pair))||compact(v)===compact(base)],
      ['long nested zero',m=>m.and(m.body.contains(base),m.or(m.body.contains(base.repeat(4)),m.body.like(`${escaped(base)}%${escaped(base.repeat(4))}`))),v=>compact(v).includes(compact(base))&&(compact(v).includes(compact(base.repeat(4)))||like(v,`${escaped(base)}%${escaped(base.repeat(4))}`))],
    ];
    const patterns=[escaped(base),`${escaped(pair)}%`,`%${escaped(pair)}`,`${escaped(pair)}%${escaped(pair)}`,`${escaped(pair)}_${escaped(pair)}`,`${escaped(pair)}%${escaped(pair)}%${escaped(pair)}`,
      `%${escaped(pair)}%`,`%${escaped(pair)}_`,`${escaped(pair)}\\%${escaped(pair)}`,`${escaped(pair)}\\\\${escaped(pair)}`,`%${escaped(pair)}%%_%%`,
      `%${escaped(base)}%${escaped(base)}%`];
    for(const pattern of [`${pair}%${single}%${pair}`,`${pair}_${single}`,`${single}%${pair}`,`${pair}%😀`])
      await assert.rejects(sealed.count(db,seal,{scope,match:m=>m.body.like(pattern)}),{code:'QUERY_TOO_BROAD'});
    await assert.rejects(sealed.count(db,seal,{scope,match:m=>(m.body.contains as any)(pair,{respectWords:true})}),{code:'INVALID_VALUE'});
    assert.ok(Object.keys(getTableColumns(seal)).every(name=>!name.startsWith('single_')&&!name.startsWith('word_')));
    for(const pattern of patterns)cases.push([`like ${pattern}`,m=>m.body.like(pattern),v=>like(v,pattern)]);
    for(const [name,match,oracle]of cases){
      const expected=inputs.filter(row=>row.body!==null&&oracle(row.body)).map(row=>row.id);
      opens=0;logs.length=0;
      assert.equal(await sealed.count(db,seal,{scope,match}),expected.length,name);
      assert.equal(opens,0,`${name}: count never opens fields`);assert.equal(logs.length,1);
      const ids:string[]=[];let cursor:string|undefined;
      do{const page=await sealed.findMany(db,seal,{scope,match,columns:{id:true},limit:3,cursor});ids.push(...page.items.map(row=>row.id));cursor=page.nextCursor??undefined;}while(cursor);
      assert.deepEqual(ids,expected,name);assert.equal(opens,0,`${name}: unprojected conditions never open`);
      const expectedOther=other.body!==null&&oracle(other.body)?[other.id]:[];
      assert.equal(await sealed.count(db,seal,{scope:otherScope,match}),expectedOther.length,`${name}: other scope count`);
      assert.deepEqual((await sealed.findMany(db,seal,{scope:otherScope,match,columns:{id:true},limit:3})).items.map(row=>row.id),expectedOther,`${name}: other scope list`);
    }
    for(const row of inputs.slice(0,3)){
      assert.equal(await sealed.count(db,seal,{scope,match:m=>m.amount.eq(row.amount)}),inputs.filter(r=>r.amount===row.amount).length);
      assert.equal(await sealed.count(db,seal,{scope,match:m=>m.big.eq(row.big)}),inputs.filter(r=>r.big===row.big).length);
      assert.equal(await sealed.count(db,seal,{scope,match:m=>m.price.eq(`+00${row.price}`)}),inputs.filter(r=>r.price===row.price).length);
      assert.equal(await sealed.count(db,seal,{scope,match:m=>m.phone.eq(row.phone.replace(/[-()+]/g,''))}),1);
      assert.equal(await sealed.count(db,seal,{scope,match:m=>m.phone.contains(row.phone.slice(2,4))}),
        inputs.filter(r=>r.phone.replace(/[-()+]/g,'').includes(row.phone.slice(2,4))).length);
      assert.equal(await sealed.count(db,seal,{scope,match:m=>m.nfc.eq(row.nfc)}),inputs.filter(r=>fold(r.nfc)===fold(row.nfc)).length);
    }
    await assert.rejects(sealed.findMany(db,seal,{scope,match:m=>m.body.contains(chars[0])}),{code:'QUERY_TOO_BROAD'});
    await assert.rejects(sealed.findMany(db,seal,{scope,match:m=>m.body.like(`${pair}\\a`)}),{code:'INVALID_VALUE'});
    const mixed=await sealed.count(db,seal,{scope,match:m=>m.or(m.body.contains(base.repeat(4)),m.sql(eq(table.id,inputs[2].id)))});
    assert.equal(mixed,1,'SQL branch can include null ciphertext');
    const joined=await sealed.search(db,{scope,match:{r:[seal,m=>m.body.contains(base)]},
      query:({where,after,orderBy,flags})=>db.select({r:{id:table.id,scopeId:table.scopeId},...flags}).from(table).where(and(where,after)).orderBy(...orderBy)});
    assert.equal(joined.items.length,inputs.filter(r=>r.body!==null&&compact(r.body).includes(compact(base))).length);
    assert.equal(opens,0,'JOIN does not need condition ciphertext');
    const before=(await pool.query(`select * from "${schemaName}".rows_seal_index where row_id=$1`,[inputs[0].id])).rows[0];
    await Promise.all(Array.from({length:8},(_,i)=>sealed.update(db,seal,{id:inputs[0].id,scopeId:scope},{body:inputs[i+1].body ?? base})));
    const after=await sealed.open(await db.select().from(table).where(eq(table.id,inputs[0].id)));
    assert.equal(await sealed.count(db,seal,{scope,where:eq(table.id,inputs[0].id),match:m=>m.body.eq(after[0].body!)}),1);
    const afterProof=(await pool.query(`select * from "${schemaName}".rows_seal_index where row_id=$1`,[inputs[0].id])).rows[0];
    const amountProof=reg.storage.index!.profiles!['amount/exact'];
    assert.deepEqual(afterProof[amountProof.exact!.salt],before[amountProof.exact!.salt]);
    await assert.rejects(db.transaction(async tx=>{await sealed.update(tx,seal,{id:inputs[0].id,scopeId:scope},{body:base});throw Error('rollback');}),/rollback/);
    assert.deepEqual((await pool.query(`select * from "${schemaName}".rows_seal_index where row_id=$1`,[inputs[0].id])).rows[0],afterProof);
    await sealed.reindex(db,seal,{batch:5});
    assert.equal(await sealed.count(db,seal,{scope,where:eq(table.id,inputs[0].id),match:m=>m.body.eq(after[0].body!)}),1);
    const key=new Uint8Array(32).fill(7),salt=new Uint8Array(16).fill(9),expected=await stamp(key,salt,3);
    const pgStamp=(await pool.query("select (('x'||encode(substr(sha256($1::bytea||$2::bytea||int4send(3)),1,8),'hex'))::bit(64)::bigint)::text value",[key,salt])).rows[0].value;
    assert.equal(pgStamp,String(expected));
    await db.delete(table).where(eq(table.id,inputs[0].id));
    assert.equal((await pool.query(`select count(*)::int n from "${schemaName}".rows_seal_index`)).rows[0].n,16);
    assert.ok(tokenPredicates>0);
  }finally{if(created)await pool.query(`drop schema "${schemaName}" cascade`);await pool.end();}
});
