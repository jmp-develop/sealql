import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { pgSchema, uuid, text, integer } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { createSealer, normalizeText } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { registrationOf } from '../src/adapters/drizzle/v0.45/native.js';
import type { MatchBuilder, NativeNode } from '../src/adapters/drizzle/v0.45/native-search.js';
import { assertDisposable } from './disposable.js';

const normalize = (v: string) => normalizeText(v, 'legacy-text-v1');

test('hardened predicates, native query surfaces, managed writes and profile migrations match plaintext', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  const schemaName = 'test_hardened_db';
  let created = false;
  const define = (hardened: boolean, substring = true) => {
    const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(93) }) }), schema = pgSchema(schemaName);
    const parent = schema.table('rows', {
      id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), status: text('status').notNull(),
      phone: sealed.text('phone', { ...(hardened ? { hardened: true as const } : {}), search: { exact: true, substring: true } }),
      name: sealed.text('name', { search: { exact: true, ...(substring ? { substring: true } : {}) } }),
      note: sealed.text('note', { hardened: true, nullable: true, search: { exact: true, substring: true } }),
      amount: sealed.integer('amount', { hardened: true, nullable: true, search: { exact: true } }),
      large: sealed.bigint('large', { hardened: true, search: { exact: true } }),
      price: sealed.decimal('price', { hardened: true, precision: 12, scale: 2, search: { exact: true } }),
    });
    const global = schema.table('global_rows', { code: sealed.textId('code').primaryKey(),
      note: sealed.text('note', { hardened: true, nullable: true, search: { exact: true, substring: true } }) });
    const seal = sealed.register(parent, { row: 'id', scope: 'scopeId' }), globalSeal = sealed.register(global, { row: 'code' });
    return { sealed, parent, seal, global, globalSeal, snapshot: generateDrizzleJson({ parent, seal, global, globalSeal }) };
  };
  try {
    await assertDisposable(pool);
    assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
    assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1', [schemaName])).rowCount, 0);
    let model = define(true);
    await pool.query(`create schema "${schemaName}"`); created = true;
    for (const statement of await generateMigration(generateDrizzleJson({}), model.snapshot)) await pool.query(statement);
    for (const statement of [...model.sealed.extraMigrationSql(model.seal), ...model.sealed.extraMigrationSql(model.globalSeal)]) await pool.query(statement);
    const db = drizzle(pool);
    const fixture = (await pool.query('select id,scope_id,phone_plain,name_plain,memo_plain,company_plain from bench_realistic_100k.customers order by id limit 40')).rows;
    assert.equal(fixture.length, 40);
    const scopeA = fixture[0].scope_id as string, scopeB = fixture[1].id as string;
    const inputs = fixture.map((f, i) => { const amount = Number.parseInt(f.phone_plain.slice(-4), 10); return {
      id: f.id as string, scopeId: i < 30 ? scopeA : scopeB, status: f.company_plain as string,
      phone: f.phone_plain as string, name: f.name_plain as string,
      note: i % 7 ? `${f.memo_plain}%_\\` : null, amount: i % 7 ? amount : null,
      large: BigInt(amount), price: `${amount}.00`,
    }; });
    await model.sealed.insert(db, model.seal, inputs);
    await model.sealed.insert(db, model.globalSeal, [{ code: fixture[0].id, note: null }, { code: fixture[1].id, note: fixture[1].memo_plain }]);
    await pool.query(`create table "${schemaName}".plain_rows(id uuid primary key,scope_id uuid not null,status text not null,phone text not null,name text not null,note text,amount integer)`);
    for (const f of inputs) await pool.query(`insert into "${schemaName}".plain_rows values($1,$2,$3,$4,$5,$6,$7)`,
      [f.id, f.scopeId, f.status, normalize(f.phone), normalize(f.name), f.note === null ? null : normalize(f.note), f.amount]);
    const ref = pgSchema(schemaName).table('plain_rows', { id: uuid('id'), scopeId: uuid('scope_id'), status: text('status'),
      phone: text('phone'), name: text('name'), note: text('note'), amount: integer('amount') });
    type M = MatchBuilder<typeof model.parent>;
    const check = async (match: (m: M) => NativeNode, condition: string, params: unknown[], limit?: number) => {
      const expected = (await pool.query(`select id,phone from "${schemaName}".plain_rows where scope_id=$1 and (${condition}) order by id${limit ? ` limit ${limit}` : ''}`, [scopeA, ...params])).rows;
      const result = await model.sealed.findMany(db, model.seal, { scope: scopeA, match, ...(limit ? { limit } : {}), columns: { id: true, phone: true } });
      assert.deepEqual(result.items.map(v => [v.id, normalize(v.phone)]), expected.map(v => [v.id, v.phone]));
      const count = await model.sealed.count(db, model.seal, { scope: scopeA, match });
      const full = (await pool.query(`select count(*)::int n from "${schemaName}".plain_rows where scope_id=$1 and (${condition})`, [scopeA, ...params])).rows[0].n;
      assert.equal(count, full);
      const where = await model.sealed.where(model.seal, { scope: scopeA, match });
      const joined = await db.select({ id: model.parent.id }).from(model.parent).innerJoin(ref, eq(ref.id, model.parent.id)).where(where).orderBy(model.parent.id);
      assert.deepEqual(joined.map(v => v.id), (await pool.query(`select id from "${schemaName}".plain_rows where scope_id=$1 and (${condition}) order by id`, [scopeA, ...params])).rows.map(v => v.id));
    };
    const f = inputs[1], prefix = f.phone.slice(0, 2), suffix = f.phone.slice(-4);
    await check(m => m.phone.eq(f.phone), 'phone=$2', [f.phone]);
    assert.equal(await model.sealed.count(db, model.seal, { scope: scopeB, match: m => m.phone.eq(f.phone) }), 0);
    await check(m => m.phone.contains(suffix), 'phone like $2', [`%${suffix}%`]);
    await check(m => m.phone.startsWith(prefix), 'phone like $2', [`${prefix}%`]);
    await check(m => m.phone.endsWith(suffix), 'phone like $2', [`%${suffix}`]);
    for (const pattern of [`%${prefix}_%${suffix}%`, `${f.phone.slice(0, 3)}_${f.phone.slice(4)}`, `%${suffix}%`, f.phone])
      await check(m => m.phone.like(pattern), 'phone like $2', [pattern]);
    await check(m => m.note.like('%\\%\\_%'), "note like $2 escape E'\\\\'", ['%\\%\\_%']);
    await check(m => m.note.endsWith('%_\\'), 'note like $2', ['%\\%\\_\\\\']);
    await check(m => m.and(m.phone.contains(suffix), m.name.eq(f.name)), 'phone like $2 and name=$3', [`%${suffix}%`, normalize(f.name)]);
    await check(m => m.or(m.phone.eq(f.phone), m.name.eq(inputs[2].name)), 'phone=$2 or name=$3', [f.phone, normalize(inputs[2].name)]);
    await check(m => m.and(m.phone.contains(prefix), m.sql(eq(model.parent.status, f.status))), 'phone like $2 and status=$3', [`%${prefix}%`, f.status]);
    await check(m => m.or(m.phone.eq(f.phone), m.sql(eq(model.parent.status, f.status))), 'phone=$2 or status=$3', [f.phone, f.status], 1);
    await check(m => m.amount.eq(f.amount!), 'amount=$2', [f.amount]);
    await check(m => m.large.eq(f.large), 'amount=$2', [f.amount]);
    await check(m => m.price.eq(f.price), 'amount=$2', [f.amount]);
    for (const limit of [1, 3, 50]) await check(m => m.phone.contains(prefix), 'phone like $2', [`%${prefix}%`], limit);
    const all = (await pool.query(`select id from "${schemaName}".plain_rows where scope_id=$1 order by id`, [scopeA])).rows.map(v => v.id);
    const paged: string[] = []; let cursor: string | null = null;
    do {
      const page: { items: { id: string }[]; nextCursor: string | null } = await model.sealed.findMany(db, model.seal, { scope: scopeA, match: m => m.or(m.phone.eq(f.phone), m.sql(sql`true`)), limit: 3, ...(cursor ? { cursor } : {}), columns: { id: true } });
      paged.push(...page.items.map(v => v.id)); cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(paged, all);
    const securePaged: string[] = []; cursor = null;
    do {
      const page: { items: { id: string }[]; nextCursor: string | null } = await model.sealed.findMany(db, model.seal, { scope: scopeA, match: m => m.or(...inputs.slice(0, 30).map(v => m.phone.startsWith(v.phone.slice(0, 2)))), limit: 3, ...(cursor ? { cursor } : {}), columns: { id: true } });
      securePaged.push(...page.items.map(v => v.id)); cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(securePaged, all);
    const predicate = await model.sealed.where(model.seal, { scope: scopeA, match: m => m.phone.contains(prefix) });
    const subquery = db.select({ id: model.parent.id }).from(model.parent).where(predicate);
    const nested = await db.select({ id: ref.id }).from(ref).where(inArray(ref.id, subquery)).orderBy(ref.id);
    const expectedPrefix = (await pool.query(`select id from "${schemaName}".plain_rows where scope_id=$1 and phone like $2 order by id`, [scopeA, `%${prefix}%`])).rows.map(v => v.id);
    assert.deepEqual(nested.map(v => v.id), expectedPrefix);
    const aggregate = await db.select({ value: sql<string>`sum(${ref.amount})::text` }).from(model.parent).innerJoin(ref, eq(ref.id, model.parent.id)).where(predicate);
    assert.equal(aggregate[0].value, (await pool.query(`select sum(amount)::text n from "${schemaName}".plain_rows where scope_id=$1 and phone like $2`, [scopeA, `%${prefix}%`])).rows[0].n);
    const search = await model.sealed.search(db, { scope: scopeA,
      match: { n: [model.seal, m => m.phone.contains(prefix)] }, limit: 2,
      query: ({ where, after, orderBy, flags, limit }) => db.select({ n: model.parent, ...flags }).from(model.parent).where(and(where, after)).orderBy(...orderBy).limit(limit),
    });
    assert.deepEqual(search.items.map(v => v.n.id), expectedPrefix.slice(0, 2));
    const unlimited = await model.sealed.search(db, { scope: scopeA,
      match: { n: [model.seal, m => m.phone.contains(prefix)] },
      query: ({ where, after, orderBy, flags, limit }) => { const query = db.select({ n: model.parent, ...flags }).from(model.parent).where(and(where, after)).orderBy(...orderBy); return limit === undefined ? query : query.limit(limit); },
    });
    assert.deepEqual(unlimited.items.map(v => v.n.id), expectedPrefix);
    const columns = (await pool.query(`select column_name from information_schema.columns where table_schema=$1 and table_name='rows_seal_index'`, [schemaName])).rows.map(v => v.column_name);
    const reg = registrationOf(model.seal);
    for (const [id, stored] of Object.entries(reg.storage.index!.profiles!)) if (!id.startsWith('name/')) assert.equal(stored.tokens, undefined);
    assert.equal(columns.filter(v => v.startsWith('tokens_')).length, 2);
    assert.equal((await pool.query(`select count(*)::int n from pg_indexes where schemaname=$1 and tablename='global_rows_seal_index' and indexdef~'(gin|tokens_)'`, [schemaName])).rows[0].n, 0);
    const unchanged = (await pool.query(`select * from "${schemaName}".rows_seal_index where row_id=$1`, [f.id])).rows[0];
    await model.sealed.update(db, model.seal, { id: f.id, scopeId: scopeA }, { name: inputs[2].name });
    const updated = (await pool.query(`select * from "${schemaName}".rows_seal_index where row_id=$1`, [f.id])).rows[0];
    for (const stored of Object.entries(reg.storage.index!.profiles!).filter(([id]) => id.startsWith('phone/')).map(([,v])=>v))
      for (const group of [stored.exact, stored.positions]) if (group) for (const name of Object.values(group)) assert.deepEqual(updated[name], unchanged[name]);
    await model.sealed.upsert(db, model.seal, { ...f, phone: inputs[2].phone });
    assert.equal(await model.sealed.count(db, model.seal, { scope: scopeA, match: m => m.phone.eq(inputs[2].phone) }), 2);
    await Promise.all([
      model.sealed.update(db, model.seal, { id: f.id, scopeId: scopeA }, { phone: inputs[3].phone }),
      model.sealed.update(db, model.seal, { id: f.id, scopeId: scopeA }, { phone: inputs[4].phone }),
    ]);
    const concurrent = (await model.sealed.open(await db.select().from(model.parent).where(eq(model.parent.id, f.id))))[0];
    assert.equal(await model.sealed.count(db, model.seal, { scope: scopeA, match: m => m.phone.eq(concurrent.phone) }), 2);
    await model.sealed.update(db, model.globalSeal, { code: fixture[1].id }, { note: null });
    await model.sealed.reindex(db, model.globalSeal, { batch: 1 });
    assert.equal((await pool.query(`select count(*)::int n from "${schemaName}".global_rows_seal_index`)).rows[0].n, 0);
    await model.sealed.update(db, model.globalSeal, { code: fixture[1].id }, { note: fixture[1].memo_plain });
    assert.equal(await model.sealed.count(db, model.globalSeal, { match: m => m.note.eq(fixture[1].memo_plain) }), 1);
    const prepare = await model.sealed.prepareAllSearch(db, { batchSize: 7 });
    assert.equal(prepare.totalRows, 42);
    assert.equal(prepare.registrations[0].verifiedRows, 40);
    // Toggle ordinary substring off/on and hardened off/on through real migrations.
    let obsoletePhoneToken: string | undefined;
    for (const [hardened, substring] of [[true, false], [false, false], [false, true], [true, true]]) {
      const next = define(hardened, substring);
      if (!hardened) obsoletePhoneToken = registrationOf(next.seal).storage.index!.profiles!['phone/exact'].tokens;
      for (const statement of await generateMigration(model.snapshot, next.snapshot)) await pool.query(statement);
      for (const statement of [...next.sealed.extraMigrationSql(next.seal), ...next.sealed.extraMigrationSql(next.globalSeal)]) await pool.query(statement);
      model = next;
      assert.equal((await model.sealed.prepareAllSearch(db, { batchSize: 7 })).totalRows, 42);
      assert.equal(await model.sealed.count(db, model.seal, { scope: scopeA, match: m => m.phone.eq(concurrent.phone) }), 2);
    }
    assert.ok(obsoletePhoneToken);
    // A transition must remove old deterministic token columns, including empty ones.
    await pool.query(`alter table "${schemaName}".rows_seal_index add column "${obsoletePhoneToken}" bigint[]`);
    await assert.rejects(model.sealed.prepareAllSearch(db), { code: 'INVALID_SCHEMA' });
    await pool.query(`alter table "${schemaName}".rows_seal_index drop column "${obsoletePhoneToken}"`);
    await pool.query(`alter table "${schemaName}".rows_seal_index add column unexpected integer`);
    await assert.rejects(model.sealed.prepareAllSearch(db), { code: 'INVALID_SCHEMA' });
    await pool.query(`alter table "${schemaName}".rows_seal_index drop column unexpected`);
    const stampColumn = registrationOf(model.seal).storage.index!.profiles!['phone/exact'].exact!.stamp;
    await pool.query(`alter table "${schemaName}".rows_seal_index alter column "${stampColumn}" type text using "${stampColumn}"::text`);
    await assert.rejects(model.sealed.prepareAllSearch(db), { code: 'INVALID_SCHEMA' });
    await pool.query(`alter table "${schemaName}".rows_seal_index alter column "${stampColumn}" type bigint using "${stampColumn}"::bigint`);
    await pool.query(`alter table "${schemaName}".rows_seal_index drop column "${stampColumn}"`);
    await assert.rejects(model.sealed.prepareAllSearch(db), { code: 'INVALID_SCHEMA' });
    await pool.query(`alter table "${schemaName}".rows_seal_index add column "${stampColumn}" bigint`);
    assert.equal((await model.sealed.prepareAllSearch(db)).totalRows, 42);
    await db.delete(model.parent).where(eq(model.parent.id, f.id));
    assert.equal((await pool.query(`select count(*)::int n from "${schemaName}".rows_seal_index where row_id=$1`, [f.id])).rows[0].n, 0);
  } finally {
    if (created) await pool.query(`drop schema "${schemaName}" cascade`);
    await pool.end();
  }
});

test('hardened bounded fallback finds sparse matches beyond the complete ID prefix', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  const schemaName = 'test_hardened_fallback';
  let created = false;
  try {
    await assertDisposable(pool);
    assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
    assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1', [schemaName])).rowCount, 0);
    const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(93) }) });
    const parent = pgSchema(schemaName).table('rows', { id: uuid('id').primaryKey(),
      phone: sealed.text('phone', { hardened: true, search: { exact: true, substring: true } }) });
    const seal = sealed.register(parent, { row: 'id' });
    await pool.query(`create schema "${schemaName}"`); created = true;
    for (const statement of await generateMigration(generateDrizzleJson({}), generateDrizzleJson({ parent, seal }))) await pool.query(statement);
    for (const statement of sealed.extraMigrationSql(seal)) await pool.query(statement);
    const fixture = (await pool.query('select id,phone_plain from bench_realistic_100k.customers order by id limit 320')).rows;
    assert.equal(fixture.length, 320);
    const db = drizzle(pool);
    await sealed.insert(db, seal, fixture.map(v => ({ id: v.id as string, phone: v.phone_plain as string })));
    const wanted = fixture[299], other = fixture[310];
    const found = await sealed.findMany(db, seal, { match: m => m.phone.eq(wanted.phone_plain), limit: 1 });
    assert.deepEqual(found.items.map(v => v.id), [wanted.id]);
    const first = await sealed.findMany(db, seal, { match: m => m.or(m.phone.eq(wanted.phone_plain), m.phone.eq(other.phone_plain)), limit: 1 });
    assert.deepEqual(first.items.map(v => v.id), [wanted.id]);
    assert.ok(first.nextCursor);
    const second = await sealed.findMany(db, seal, { match: m => m.or(m.phone.eq(wanted.phone_plain), m.phone.eq(other.phone_plain)), limit: 1, cursor: first.nextCursor });
    assert.deepEqual(second.items.map(v => v.id), [other.id]);
    await sealed.update(db, seal, { id: wanted.id }, { phone: '' });
    assert.equal(await sealed.count(db, seal, { match: m => m.phone.eq('') }), 1);
    const oneCharacter = wanted.phone_plain.slice(-1);
    await sealed.update(db, seal, { id: wanted.id }, { phone: oneCharacter });
    assert.equal(await sealed.count(db, seal, { match: m => m.phone.eq(oneCharacter) }), 1);
    assert.equal((await sealed.reindex(db, seal, { batch: 33 })).rows, 320);
    assert.equal(await sealed.count(db, seal, { match: m => m.phone.eq(oneCharacter) }), 1);
  } finally {
    if (created) await pool.query(`drop schema "${schemaName}" cascade`);
    await pool.end();
  }
});
