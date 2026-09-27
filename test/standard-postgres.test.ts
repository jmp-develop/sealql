import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealer, normalizeText, profiles, searchPieces, searchTokens, SealError } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { registrationOf } from '../src/adapters/drizzle/v0.45/native.js';
import { companionIndexName } from '../src/core/companion-layout.js';
import { canonical } from '../src/core/bytes.js';
import { assertDisposable } from './disposable.js';

const source = 'bench_realistic_100k';
const norm = (value: string) => normalizeText(value, 'legacy-text-v1');
async function setup(caseName: string, count: number) {
  const schemaName = `test_native_${caseName}_${process.pid}`;
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  const rows = (await pool.query(`select id,scope_id,memo_plain,address_plain,name_plain from ${source}.customers order by id limit $1`, [count])).rows as
    { id: string; scope_id: string; memo_plain: string; address_plain: string; name_plain: string }[];
  assert.equal(rows.length, count);
  assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1', [schemaName])).rowCount, 0);
  await pool.query(`create schema "${schemaName}"`);
  try {
    const schema = pgSchema(schemaName), cipher = createSealer({ key: new Uint8Array(32).fill(7) });
    const sealed = createSealed({ sealer: cipher });
    const memo = schema.table('memo', { id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
      body: sealed.text('body', { search: { exact: true, substring: true } }),
      address: sealed.text('address', { search: { substring: true } }),
      amount: sealed.integer('amount', { nullable: true, search: { exact: true } }),
    });
    const seal = sealed.register(memo, { row: 'id', scope: 'scopeId' });
    const profiles = registrationOf(seal).storage.index!.profiles!;
    const tokenColumns = Object.values(profiles).map(profile => `"${profile.tokens}" bigint[]`).join(',');
    await pool.query(`create table "${schemaName}".memo (id uuid primary key,scope_id uuid not null,body_ct bytea not null,address_ct bytea not null,amount_ct bytea)`);
    await pool.query(`create table "${schemaName}".memo_seal_index (scope_id uuid not null,row_id uuid not null,${tokenColumns},unique(scope_id,row_id),foreign key(row_id) references "${schemaName}".memo(id) on delete cascade)`);
    for (const [profileId, profile] of Object.entries(profiles)) if (profile.mode === 'exact')
      await pool.query(`create index "${companionIndexName('memo_seal_index', profileId)}_bt" on "${schemaName}".memo_seal_index(scope_id,(("${profile.tokens}")[1]),row_id)`);
    const substring = Object.values(profiles).filter(profile => profile.mode === 'substring');
    await pool.query(`create index "${companionIndexName('memo_seal_index', 'substring')}_gin" on "${schemaName}".memo_seal_index using gin(${substring.map(profile => `"${profile.tokens}"`).join(',')})`);
    const logs: string[] = [];
    const db = drizzle(pool, { logger: { logQuery(query) { logs.push(query); } } });
    for (let start = 0; start < rows.length; start += 500) await sealed.insert(db, seal, rows.slice(start, start + 500).map(row => ({
      id: row.id, scopeId: row.scope_id, body: row.memo_plain, address: row.address_plain, amount: row.name_plain.length,
    })));
    const close = async () => { await pool.query(`drop schema "${schemaName}" cascade`); await pool.end(); };
    return { rows, schemaName, pool, db, sealed, cipher, memo, seal, profiles, logs, close };
  } catch (error) { await pool.query(`drop schema "${schemaName}" cascade`); await pool.end(); throw error; }
}

test('native CRUD, verified pages, OR semi-join and bounded count', async () => {
  const c = await setup('crud', 30);
  try {
    const scope = c.rows[0].scope_id, exact = c.rows[0].memo_plain;
    c.logs.length = 0;
    assert.equal((await c.sealed.findMany(c.db, c.seal, { scope, match: m => m.body.eq(exact), limit: 1 })).items.length, 1);
    assert.equal(c.logs.length, 1, 'one candidate SQL request for an exact page');
    assert.ok(c.logs[0].includes(' in (select '));
    assert.ok(!c.logs[0].includes('exists('));
    await assert.rejects(c.sealed.findMany(c.db, c.seal, { scope, match: m => m.body.contains('a') }), { code: 'QUERY_TOO_BROAD' });
    const literal = Array.from(exact).slice(0, 3).join('');
    assert.equal((await c.sealed.findMany(c.db, c.seal, { scope, match: m => m.body.like(`% ${literal} %`) })).items.length,
      c.rows.filter(row => norm(row.memo_plain).includes(norm(literal))).length);
    const expected = c.rows.filter(row => norm(row.memo_plain).includes('빠른') || norm(row.memo_plain) === norm(exact)).map(row => row.id);
    c.logs.length = 0;
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.sealed.findMany(c.db, c.seal, { scope, match: m => m.or(m.body.contains('빠른'), m.body.eq(exact)), limit: 7, cursor });
      ids.push(...page.items.map(row => row.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(ids, expected);
    const tinyBytes = canonical({ id: c.rows[0].id, scopeId: scope }).length + 1;
    const allIds: string[] = [];
    let tinyCursor: string | undefined;
    do {
      const page = await c.sealed.findMany(c.db, c.seal, { scope, columns: { id: true }, limit: 30,
        cursor: tinyCursor, budgets: { resultBytes: tinyBytes } });
      allIds.push(...page.items.map(row => row.id)); tinyCursor = page.nextCursor ?? undefined;
    } while (tinyCursor);
    assert.deepEqual(allIds, c.rows.map(row => row.id), 'short budget pages resume without losing any of 30 rows');
    assert.ok(c.logs.some(query => query.includes('with sample as materialized')));
    assert.equal(await c.sealed.count(c.db, c.seal, { scope, match: m => m.or(m.body.contains('빠른'), m.body.eq(exact)), maxCandidates: 50 }), expected.length);
    await assert.rejects(c.sealed.count(c.db, c.seal, { scope, match: m => m.body.contains('빠른'), maxCandidates: 1 }),
      (error: unknown) => error instanceof SealError && error.code === 'LIMIT_EXCEEDED');
    const first = c.rows[0], second = c.rows[1];
    const before = (await c.pool.query(`select * from "${c.schemaName}".memo_seal_index where row_id=$1`, [first.id])).rows[0];
    const exactProfile = profiles('memo', 'body', registrationOf(c.seal).definition.fields.body).find(profile => profile.mode === 'exact')!;
    const expectedToken = await searchTokens(c.cipher.ring('memo'), scope, exactProfile, searchPieces(exactProfile, first.memo_plain), { profiles: new Map() });
    assert.deepEqual(before[c.profiles['body/exact'].tokens].map(String), expectedToken);
    assert.equal(c.logs.some(query => query.includes('collate "C"')), false, 'UUID candidate SQL keeps its original comparison');
    const explain = await c.pool.query(`explain (format json) select id from "${c.schemaName}".memo where id in
      (select row_id from "${c.schemaName}".memo_seal_index where scope_id=$1 and ("${c.profiles['body/exact'].tokens}")[1]=$2::bigint)`,
    [scope, expectedToken[0]]);
    assert.ok(Array.isArray(explain.rows[0]['QUERY PLAN']));
    const substringProfile = profiles('memo', 'body', registrationOf(c.seal).definition.fields.body).find(profile => profile.mode === 'substring')!;
    const expectedSubstring = await searchTokens(c.cipher.ring('memo'), scope, substringProfile,
      searchPieces(substringProfile, first.memo_plain), { profiles: new Map() });
    assert.deepEqual(before[c.profiles['body/substring'].tokens].map(String), expectedSubstring);
    await c.sealed.update(c.db, c.seal, { id: first.id, scopeId: scope }, { body: second.memo_plain });
    const after = (await c.pool.query(`select * from "${c.schemaName}".memo_seal_index where row_id=$1`, [first.id])).rows[0];
    assert.deepEqual(after[c.profiles['amount/exact'].tokens], before[c.profiles['amount/exact'].tokens]);
    assert.notDeepEqual(after[c.profiles['body/exact'].tokens], before[c.profiles['body/exact'].tokens]);
    assert.equal((await c.sealed.findMany(c.db, c.seal, { scope, match: m => m.body.eq(first.memo_plain) })).items.length,
      c.rows.filter(row => row.id !== first.id && norm(row.memo_plain) === norm(first.memo_plain)).length);
    assert.equal((await c.sealed.findMany(c.db, c.seal, { scope,
      match: m => m.and(m.body.eq(second.memo_plain), m.address.contains(Array.from(norm(first.address_plain)).slice(0, 2).join(''))) })).items.some(row => row.id === first.id), true);
    await c.sealed.update(c.db, c.seal, { id: first.id, scopeId: scope }, { amount: null });
    const nulled = (await c.pool.query(`select * from "${c.schemaName}".memo_seal_index where row_id=$1`, [first.id])).rows[0];
    assert.equal(nulled[c.profiles['amount/exact'].tokens], null);
    assert.equal((await c.sealed.open(await c.db.select().from(c.memo).where(eq(c.memo.id, first.id))))[0].body, second.memo_plain);
    await assert.rejects(c.sealed.update(c.db, c.seal, { id: c.rows[29].id, scopeId: c.rows[29].id }, { body: second.memo_plain }),
      (error: unknown) => error instanceof SealError && error.code === 'NOT_FOUND');
    await c.db.delete(c.memo).where(eq(c.memo.id, first.id));
    assert.equal((await c.pool.query(`select 1 from "${c.schemaName}".memo_seal_index where row_id=$1`, [first.id])).rowCount, 0);
  } finally { await c.close(); }
});

test('high false-positive pages grow batches without losing rows', async () => {
  const c = await setup('batch', 220);
  try {
    const term = '빠른', scope = c.rows[0].scope_id;
    const expected = c.rows.filter(row => norm(row.memo_plain).includes(term)).map(row => row.id);
    assert.ok(expected.length >= 8);
    const tokens = c.profiles['body/substring'].tokens;
    await c.pool.query(`update "${c.schemaName}".memo_seal_index as target set "${tokens}"=source."${tokens}"
      from "${c.schemaName}".memo_seal_index as source where source.row_id=$1 and target.row_id<>source.row_id`, [expected[0]]);
    const originalOpen = c.cipher.open.bind(c.cipher);
    let active = 0, peak = 0, conditionOpens = 0, projectedOpens = 0;
    c.cipher.open = async (...args) => {
      if (args[1].fieldId === 'body') conditionOpens++;
      if (args[1].fieldId === 'address') projectedOpens++;
      active++; peak = Math.max(peak, active);
      try { await new Promise(resolve => setTimeout(resolve, 1)); return await originalOpen(...args); }
      finally { active--; }
    };
    c.logs.length = 0;
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const beforeCalls = c.logs.length;
      const page = await c.sealed.findMany(c.db, c.seal, { scope, match: m => m.body.contains(term), limit: 8, cursor, budgets: { batch: 500 } });
      assert.ok(c.logs.length - beforeCalls <= 4, 'candidate SQL batches stay bounded per page');
      ids.push(...page.items.map(row => row.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(ids, expected);
    assert.ok(peak > 1 && peak <= 64, `bounded parallel authentication peak=${peak}`);
    assert.ok(conditionOpens > projectedOpens, 'false positives do not open projected fields');
    assert.equal(projectedOpens, expected.length, 'no projection decryption beyond accepted page rows');
    assert.ok(c.logs.some(query => query.includes('with sample as materialized')));
    assert.ok(c.logs.length > Math.ceil(expected.length / 8), 'false positives require additional candidate batches');
  } finally { await c.close(); }
});

test('multicolumn GIN preserves writes, cursor search and exact count', async () => {
  const c = await setup('multi', 12);
  try {
    const indexes = (await c.pool.query('select indexdef from pg_indexes where schemaname=$1 and tablename=$2 and indexdef like $3',
      [c.schemaName, 'memo_seal_index', '%USING gin%'])).rows;
    assert.equal(indexes.length, 1);
    assert.equal((indexes[0].indexdef.match(/tokens_[a-f0-9]{16}/g) ?? []).length, 2);
    assert.equal(c.sealed.extraMigrationSql(c.seal).length, 2);
    const bodyTerm = Array.from(norm(c.rows[0].memo_plain)).slice(0, 2).join('');
    const addressTerm = Array.from(norm(c.rows[0].address_plain)).slice(0, 2).join('');
    const expected = c.rows.filter(row => norm(row.memo_plain).includes(bodyTerm) && norm(row.address_plain).includes(addressTerm)).map(row => row.id);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.sealed.findMany(c.db, c.seal, { scope: c.rows[0].scope_id,
        match: m => m.and(m.body.contains(bodyTerm), m.address.contains(addressTerm)), limit: 2, cursor });
      ids.push(...page.items.map(row => row.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(ids, expected);
    assert.equal(await c.sealed.count(c.db, c.seal, { scope: c.rows[0].scope_id,
      match: m => m.and(m.body.contains(bodyTerm), m.address.contains(addressTerm)), maxCandidates: 50 }), expected.length);
    const changed = c.rows[1].memo_plain;
    await c.sealed.update(c.db, c.seal, { id: c.rows[0].id, scopeId: c.rows[0].scope_id }, { body: changed });
    assert.equal((await c.sealed.open(await c.db.select().from(c.memo).where(eq(c.memo.id, c.rows[0].id))))[0].body, changed);
    const changedTerm = Array.from(norm(changed)).slice(0, 2).join('');
    assert.ok((await c.sealed.findMany(c.db, c.seal, { scope: c.rows[0].scope_id,
      match: m => m.and(m.body.contains(changedTerm), m.address.contains(addressTerm)) })).items.some(row => row.id === c.rows[0].id));
    await c.db.delete(c.memo).where(eq(c.memo.id, c.rows[0].id));
    assert.equal(await c.sealed.count(c.db, c.seal, { scope: c.rows[0].scope_id,
      match: m => m.and(m.body.contains(changedTerm), m.address.contains(addressTerm)), maxCandidates: 50 }),
      c.rows.slice(1).filter(row => norm(row.memo_plain).includes(changedTerm) && norm(row.address_plain).includes(addressTerm)).length);
  } finally { await c.close(); }
});

test('reindex handles a fixture-derived batch above the public open row default', async () => {
  const c = await setup('reindex', 501);
  try {
    assert.deepEqual(await c.sealed.reindex(c.db, c.seal, { batch: 501 }), { rows: 501 });
    const first = c.rows[0];
    c.logs.length = 0;
    await c.sealed.findMany(c.db, c.seal, { scope: first.scope_id,
      match: m => m.body.contains(Array.from(norm(first.memo_plain)).slice(0, 2).join('')),
      limit: 200, budgets: { batch: 500 } });
    assert.ok(c.logs.some(query => query.includes('memo_seal_index') && !query.includes('with sample as materialized')),
      'candidate batches above 200 use the direct index path');
    assert.equal((await c.sealed.findMany(c.db, c.seal, { scope: first.scope_id,
      match: m => m.body.eq(first.memo_plain), limit: 1 })).items[0].id, first.id);
  } finally { await c.close(); }
});

test('count spans internal pages and accepts an exact candidate ceiling', async () => {
  const c = await setup('count_pages', 2001);
  try {
    const scope = c.rows[0].scope_id;
    assert.equal(c.rows.filter(row => row.scope_id === scope).length, 2001);
    assert.equal(await c.sealed.count(c.db, c.seal, { scope, maxCandidates: 2001,
      budgets: { deadlineMs: 30000, fetchBytes: 32 * 1024 * 1024, resultBytes: 32 * 1024 * 1024 } }), 2001);
    await assert.rejects(c.sealed.count(c.db, c.seal, { scope, maxCandidates: 2000,
      budgets: { deadlineMs: 30000, fetchBytes: 32 * 1024 * 1024, resultBytes: 32 * 1024 * 1024 } }),
    { code: 'LIMIT_EXCEEDED' });
    await assert.rejects(c.sealed.count(c.db, c.seal, { scope, maxCandidates: 2001,
      budgets: { deadlineMs: 1 } }), { code: 'LIMIT_EXCEEDED' });
  } finally { await c.close(); }
});
