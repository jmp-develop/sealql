import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { integer, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createSealer, normalizeText, profiles, searchPieces, searchTokens, SealError } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { registrationOf } from '../src/adapters/drizzle/v0.45/native.js';
import { companionIndexName } from '../src/core/companion-layout.js';
import { canonical } from '../src/core/bytes.js';
import { assertDisposable } from './disposable.js';
import { installProofColumns } from './proof-schema.js';

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
      rank: integer('rank'), label: text('label'), extra: text('extra').$defaultFn(() => 'default'),
      moment: timestamp('moment', { withTimezone: true, precision: 6 }),
      body: sealed.text('body', { search: { exact: true, substring: true } }),
      address: sealed.text('address', { search: { substring: true } }),
      amount: sealed.integer('amount', { nullable: true, search: { exact: true } }),
      jsonData: sealed.json('json_data', { nullable: true }),
    });
    const seal = sealed.register(memo, { row: 'id', scope: 'scopeId' });
    const profiles = registrationOf(seal).storage.index!.profiles!;
    const tokenColumns = Object.values(profiles).map(profile => `"${profile.tokens}" bigint[]`).join(',');
    await pool.query(`create table "${schemaName}".memo (id uuid primary key,scope_id uuid not null,rank integer,label text,extra text,moment timestamptz(6),body_ct bytea not null,address_ct bytea not null,amount_ct bytea,json_data_ct bytea)`);
    await pool.query(`create table "${schemaName}".memo_seal_index (scope_id uuid not null,row_id uuid not null,${tokenColumns},unique(scope_id,row_id),foreign key(row_id) references "${schemaName}".memo(id) on delete cascade)`);
    for (const [profileId, profile] of Object.entries(profiles)) if (profile.mode === 'exact')
      await pool.query(`create index "${companionIndexName('memo_seal_index', profileId)}_bt" on "${schemaName}".memo_seal_index(scope_id,(("${profile.tokens}")[1]),row_id)`);
    const substring = Object.values(profiles).filter(profile => profile.mode === 'substring');
    await pool.query(`create index "${companionIndexName('memo_seal_index', 'substring')}_gin" on "${schemaName}".memo_seal_index using gin(${substring.map(profile => `"${profile.tokens}"`).join(',')})`);
    await installProofColumns(pool, seal);
    const logs: string[] = [], logEntries: { query: string; params: unknown[] }[] = [];
    const db = drizzle(pool, { logger: { logQuery(query, params) { logs.push(query); logEntries.push({ query, params }); } } });
    for (let start = 0; start < rows.length; start += 500) await sealed.insert(db, seal, rows.slice(start, start + 500).map(row => ({
      id: row.id, scopeId: row.scope_id, rank: row.name_plain.length % 4 === 0 ? null : row.name_plain.length % 3,
      label: row.name_plain.length % 5 === 0 ? null : row.name_plain.slice(0, 2),
      body: row.memo_plain, address: row.address_plain, amount: row.name_plain.length,
    })));
    const close = async () => { await pool.query(`drop schema "${schemaName}" cascade`); await pool.end(); };
    return { rows, schemaName, pool, db, sealed, cipher, memo, seal, profiles, logs, logEntries, close };
  } catch (error) { await pool.query(`drop schema "${schemaName}" cascade`); await pool.end(); throw error; }
}

test('native CRUD, verified pages, OR semi-join and bounded count', async () => {
  const c = await setup('crud', 30);
  try {
    const scope = c.rows[0].scope_id, exact = c.rows[0].memo_plain;
    const unrestricted = await c.sealed.findMany(c.db, c.seal, { scope, columns: { id: true } });
    assert.deepEqual(unrestricted.items.map(row => row.id), c.rows.map(row => row.id));
    assert.equal(unrestricted.nextCursor, null);
    const firstSized = await c.sealed.findMany(c.db, c.seal, { scope, columns: { id: true }, limit: 2 });
    const nextSized = await c.sealed.findMany(c.db, c.seal, { scope, columns: { body: true }, limit: 3,
      cursor: firstSized.nextCursor! });
    assert.deepEqual(nextSized.items.map(row => row.id), c.rows.slice(2, 5).map(row => row.id));
    assert.ok(nextSized.items[0].body);
    const expectedSorted = (await c.pool.query(`select id from "${c.schemaName}".memo where scope_id=$1
      order by rank asc nulls last,label asc nulls last,id asc`, [scope])).rows.map(row => row.id);
    const sortedIds: string[] = [];
    let sortedCursor: string | undefined;
    do {
      const page = await c.sealed.findMany(c.db, c.seal, { scope, columns: { rank: true, label: true },
        orderBy: [{ column: c.memo.rank, direction: 'asc' }, { column: c.memo.label, direction: 'asc' }],
        limit: 4, cursor: sortedCursor });
      sortedIds.push(...page.items.map(row => row.id));
      sortedCursor = page.nextCursor ?? undefined;
    } while (sortedCursor);
    assert.deepEqual(sortedIds, expectedSorted);
    const joinedIds: string[] = [];
    let joinedCursor: string | undefined;
    do {
      const page = await c.sealed.search(c.db, { scope, match: { m: [c.seal, m => m.sql(sql`true`)] },
        keyset: [c.memo.rank], limit: 4, cursor: joinedCursor,
        query: ({ where, after, orderBy, flags, limit }) => c.db.select({ m: c.memo, ...flags }).from(c.memo)
          .where(and(where, after)).orderBy(...orderBy).limit(limit!),
      });
      joinedIds.push(...page.items.map(row => row.m.id));
      joinedCursor = page.nextCursor ?? undefined;
    } while (joinedCursor);
    assert.deepEqual(joinedIds, c.rows.map(row => row.id));
    c.logs.length = 0;
    assert.equal(await c.sealed.count(c.db, c.seal, { scope, match: m => m.body.eq(exact) }), 1);
    assert.equal(c.logs.length, 1, 'count computes candidates in one SQL request');
    c.logs.length = 0;
    assert.equal((await c.sealed.findMany(c.db, c.seal, { scope, match: m => m.body.eq(exact), limit: 1 })).items.length, 1);
    assert.equal(c.logs.length, 1, 'one candidate SQL request for an exact page');
    assert.ok(c.logs[0].includes(' in (select '));
    assert.ok(!c.logs[0].includes('exists('));
    c.logs.length = 0;
    assert.equal((await c.sealed.search(c.db, { scope,
      match: { m: [c.seal, m => m.body.eq(exact)] },
      query: ({ where, after, orderBy, flags, limit }) => {
        const query = c.db.select({ m: c.memo, ...flags }).from(c.memo).where(and(where, after)).orderBy(...orderBy);
        return limit === undefined ? query : query.limit(limit);
      },
    })).items.length, 1);
    assert.equal(c.logs.length, 1, 'UUID search needs only its candidate SQL request');
    await assert.rejects(c.sealed.findMany(c.db, c.seal, { scope, match: m => m.body.contains('a') }), { code: 'QUERY_TOO_BROAD' });
    const prefixTerm = Array.from(norm(exact)).slice(0, 2).join('');
    const defaultRequestIndex = c.logEntries.length;
    await c.sealed.findMany(c.db, c.seal, { scope, match: m => m.body.contains(prefixTerm), limit: 200 });
    assert.match(c.logEntries[defaultRequestIndex].query, /with sample as materialized/i, 'limit-200 first request uses the prefix path');
    assert.equal(c.logEntries[defaultRequestIndex].params.at(-1), 200);
    const callerRequestIndex = c.logEntries.length;
    await c.sealed.findMany(c.db, c.seal, { scope, match: m => m.body.contains(prefixTerm), limit: 200,
      budgets: { batch: 251 } });
    assert.equal(c.logEntries[callerRequestIndex].params.at(-1), 251, 'caller batch caps the first request size');
    const largeBatchRequestIndex = c.logEntries.length;
    await c.sealed.findMany(c.db, c.seal, { scope, match: m => m.body.contains(prefixTerm), limit: 20,
      budgets: { batch: 500 } });
    assert.equal(c.logEntries[largeBatchRequestIndex].params.at(-1), 27, 'caller batch does not enlarge the first request beyond the heuristic');
    const searchLimits: Array<number | undefined> = [];
    const searchWithBatch = (batch?: number) => c.sealed.search(c.db, { scope,
      match: { m: [c.seal, m => m.body.contains(prefixTerm)] }, limit: 200,
      ...(batch === undefined ? {} : { budgets: { batch } }),
      query: ({ limit }) => { searchLimits.push(limit); return []; },
    });
    await searchWithBatch();
    await searchWithBatch(251);
    await c.sealed.search(c.db, { scope, match: { m: [c.seal, m => m.body.contains(prefixTerm)] },
      limit: 20, budgets: { batch: 500 }, query: ({ limit }) => { searchLimits.push(limit); return []; } });
    assert.deepEqual(searchLimits, [200, 251, 27], 'search uses the same first request cap');
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
    const exactSql = c.logEntries.find(entry => entry.query.includes(' in (select ') && entry.query.includes(c.profiles['body/exact'].tokens));
    assert.ok(exactSql);
    assert.doesNotMatch(exactSql.query, /collate "C"/i);
    const prefixSql = c.logEntries.find(entry => entry.query.includes('with sample as materialized'));
    assert.ok(prefixSql);
    const keysetSql = c.logEntries.find(entry => /"memo"\."id"\s*>\s*\$\d+/.test(entry.query));
    assert.ok(keysetSql);
    const explainClient = await c.pool.connect();
    try {
      await explainClient.query('begin');
      await explainClient.query('set local enable_seqscan=off');
      await explainClient.query('set local enable_bitmapscan=off');
      for (const entry of [exactSql, prefixSql, keysetSql]) {
        const explain = await explainClient.query(`explain ${entry.query}`, entry.params);
        const plan = explain.rows.map(row => row['QUERY PLAN']).join('\n');
        assert.match(plan, /Index (?:Only )?Scan using .*memo_pkey/, plan);
        assert.doesNotMatch(plan, /Seq Scan on memo /, plan);
        if (entry === keysetSql) assert.doesNotMatch(plan, /Sort/, plan);
      }
    } finally { await explainClient.query('rollback'); explainClient.release(); }
    await c.pool.query(`create index memo_rank_label_id on "${c.schemaName}".memo(scope_id,rank,label,id)`);
    c.logEntries.length = 0;
    const indexedFirst = await c.sealed.findMany(c.db, c.seal, { scope,
      orderBy: [{ column: c.memo.rank, direction: 'asc' }, { column: c.memo.label, direction: 'asc' }],
      columns: { id: true }, limit: 2 });
    await c.sealed.findMany(c.db, c.seal, { scope,
      orderBy: [{ column: c.memo.rank, direction: 'asc' }, { column: c.memo.label, direction: 'asc' }],
      columns: { id: true }, limit: 2, cursor: indexedFirst.nextCursor! });
    const indexedKeysetSql = c.logEntries.at(-1)!;
    const indexedClient = await c.pool.connect();
    try {
      await indexedClient.query('begin');
      await indexedClient.query('set local enable_seqscan=off');
      await indexedClient.query('set local enable_bitmapscan=off');
      const plan = (await indexedClient.query(`explain ${indexedKeysetSql.query}`, indexedKeysetSql.params))
        .rows.map(row => row['QUERY PLAN']).join('\n');
      assert.match(plan, /Index (?:Only )?Scan using memo_rank_label_id/, plan);
      assert.doesNotMatch(plan, /Sort/, plan);
    } finally { await indexedClient.query('rollback'); indexedClient.release(); }
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

test('large searchable fields and public open have no implicit size or row budget', async () => {
  const c = await setup('large_open', 501);
  try {
    const opened = await c.sealed.open(await c.db.select().from(c.memo));
    assert.equal(opened.length, 501);
    assert.equal((await c.sealed.findMany(c.db, c.seal, { scope: c.rows[0].scope_id,
      columns: { id: true }, limit: 501 })).items.length, 501);
    const first = c.rows[0];
    const longText = first.memo_plain.repeat(Math.ceil(70000 / first.memo_plain.length));
    await c.sealed.update(c.db, c.seal, { id: first.id, scopeId: first.scope_id }, { body: longText });
    const found = await c.sealed.findMany(c.db, c.seal, {
      scope: first.scope_id, match: m => m.body.contains(longText.slice(0, 2050)), columns: { body: true },
    });
    assert.equal(found.items.length, 1);
    assert.equal(found.items[0].body, longText);
    assert.equal((await c.sealed.findMany(c.db, c.seal, {
      scope: first.scope_id, match: m => m.body.like(`${longText.slice(0, 2)}${'%'.repeat(30)}`),
      columns: { id: true },
    })).items.length, 1);
  } finally { await c.close(); }
});

test('insert splits above the PostgreSQL parameter limit within one transaction', async () => {
  const c = await setup('bulk_params', 1);
  try {
    const sourceRows = (await c.pool.query(`select id,scope_id,memo_plain,address_plain,name_plain
      from bench_realistic_100k.customers order by id limit 10000 offset 1`)).rows;
    assert.equal(sourceRows.length, 10000);
    const records = sourceRows.map(row => ({
      id: row.id as string, scopeId: row.scope_id as string,
      body: row.memo_plain as string, address: row.address_plain as string,
    }));
    const duplicate = { ...records[records.length - 1], id: c.rows[0].id };
    await assert.rejects(c.sealed.insert(c.db, c.seal, [...records.slice(0, -1), duplicate]),
      { code: 'CONSTRAINT_VIOLATION' });
    const parentAfterFailure = await c.pool.query(`select count(*)::int as n from "${c.schemaName}".memo`);
    const indexAfterFailure = await c.pool.query(`select count(*)::int as n from "${c.schemaName}".memo_seal_index`);
    assert.equal(parentAfterFailure.rows[0].n, 1);
    assert.equal(indexAfterFailure.rows[0].n, 1);
    c.logEntries.length = 0;
    const inserted = await c.sealed.insert(c.db, c.seal, records);
    assert.equal(inserted.length, 10000);
    const parentInserts = c.logEntries.filter(entry => entry.query.includes(`insert into "${c.schemaName}"."memo"`));
    assert.ok(parentInserts.length > 1, 'defaultFn columns require parent insert splitting');
    assert.ok(parentInserts.every(entry => entry.params.length <= 60000));
    assert.equal((await c.pool.query(`select count(*)::int as n from "${c.schemaName}".memo`)).rows[0].n, 10001);
    assert.equal((await c.pool.query(`select count(*)::int as n from "${c.schemaName}".memo_seal_index`)).rows[0].n, 10001);
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
    const firstPage = await c.sealed.findMany(c.db, c.seal, { scope, match: m => m.body.contains(term), limit: 8,
      budgets: { batch: 16 } });
    assert.equal(firstPage.items.length, 8);
    const candidateRequests = c.logs.filter(query => query.includes('from') && query.includes('"memo"'));
    assert.ok(candidateRequests.length > 1, 'first candidate batch requires a follow-up');
    assert.ok(candidateRequests.every(query => /\blimit\s+\$\d+/i.test(query)), 'every limited page request has SQL LIMIT');
    c.logs.length = 0;
    conditionOpens = 0; projectedOpens = 0; peak = 0;
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

test('reindex accepts a caller batch above the old maximum', async () => {
  const c = await setup('reindex', 1001);
  try {
    assert.deepEqual(await c.sealed.reindex(c.db, c.seal, { batch: 1001 }), { rows: 1001 });
    c.logEntries.length = 0;
    assert.deepEqual(await c.sealed.reindex(c.db, c.seal), { rows: 1001 });
    const locks = c.logEntries.filter(entry => /for update/i.test(entry.query));
    assert.equal(locks.length, 2);
    assert.ok(locks.every(entry => entry.params.at(-1) === 1000));
    const first = c.rows[0];
    c.logs.length = 0;
    await c.sealed.findMany(c.db, c.seal, { scope: first.scope_id,
      match: m => m.body.contains(Array.from(norm(first.memo_plain)).slice(0, 2).join('')),
      limit: 200, budgets: { batch: 501 } });
    assert.ok(c.logs.some(query => query.includes('memo_seal_index') && !query.includes('with sample as materialized')),
      'candidate batches above 200 use the direct index path');
    assert.equal((await c.sealed.findMany(c.db, c.seal, { scope: first.scope_id,
      match: m => m.body.eq(first.memo_plain), limit: 1 })).items[0].id, first.id);
  } finally { await c.close(); }
});

test('count uses one SQL candidate stream and accepts an exact candidate ceiling', async () => {
  const c = await setup('count_pages', 2001);
  try {
    const scope = c.rows[0].scope_id;
    assert.equal(c.rows.filter(row => row.scope_id === scope).length, 2001);
    c.logs.length = 0;
    assert.equal(await c.sealed.count(c.db, c.seal, { scope, maxCandidates: 2001,
      budgets: { deadlineMs: 30000, fetchBytes: 32 * 1024 * 1024, resultBytes: 32 * 1024 * 1024 } }), 2001);
    assert.equal(c.logs.length, 1);
    assert.match(c.logs[0], /\blimit\s+\$\d+/i);
    assert.equal(c.logEntries.at(-1)?.params.at(-1), 2002);
    await assert.rejects(c.sealed.count(c.db, c.seal, { scope, maxCandidates: 2000,
      budgets: { deadlineMs: 30000, fetchBytes: 32 * 1024 * 1024, resultBytes: 32 * 1024 * 1024 } }),
    { code: 'LIMIT_EXCEEDED' });
    await assert.rejects(c.sealed.count(c.db, c.seal, { scope, maxCandidates: 2001,
      budgets: { deadlineMs: 1 } }), { code: 'LIMIT_EXCEEDED' });
  } finally { await c.close(); }
});

test('microsecond timestamp keysets resume under another DateStyle', async () => {
  const c = await setup('microseconds', 3);
  const client = await c.pool.connect();
  try {
    await assertDisposable(c.pool);
    assert.equal(Number((await client.query('show port')).rows[0].port), 56439);
    const dates = ['2024-02-03 04:05:06.000001+00', '2024-02-03 04:05:06.000002+00', '2024-02-03 04:05:06.000003+00'];
    for (let i = 0; i < 3; i++) await client.query(`update "${c.schemaName}".memo set moment=$1 where id=$2`, [dates[i], c.rows[i].id]);
    const db = drizzle(client);
    const scope = c.rows[0].scope_id;
    const expected = (await client.query(`select id from "${c.schemaName}".memo where scope_id=$1 order by moment,id`, [scope])).rows.map(row => row.id);
    assert.equal(expected.length, 3);
    await client.query("set datestyle to 'SQL, DMY'");
    const findIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.sealed.findMany(db, c.seal, { scope, orderBy: { column: c.memo.moment, direction: 'asc' }, limit: 1, cursor });
      findIds.push(...page.items.map(row => row.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(findIds, expected);
    const positions = pgSchema(c.schemaName).table('positions', { id: text('id').primaryKey(), value: timestamp('value', { withTimezone: true, precision: 6 }).notNull() });
    await client.query(`create table "${c.schemaName}".positions (id text primary key,value timestamptz(6) not null)`);
    for (let i = 0; i < 3; i++) await client.query(`insert into "${c.schemaName}".positions(id,value) values($1,$2)`, [`p${i}`, dates[i]]);
    const expectedPositions = (await client.query(`select id from "${c.schemaName}".positions order by value`)).rows.map(row => row.id);
    const searchIds: string[] = [];
    cursor = undefined;
    do {
      const page: { items: any[]; nextCursor: string | null } = await c.sealed.search(db, { scope, match: { n: [c.seal, m => m.sql(sql`true`)] }, keyset: [positions.value], limit: 1, cursor,
        query: ({ where, after, orderBy, flags, limit }) => db.select({ n: c.memo, positionId: positions.id, ...flags }).from(c.memo)
          .innerJoin(positions, sql`true`).where(and(where, eq(c.memo.id, c.rows[0].id), after)).orderBy(...orderBy).limit(limit!),
      });
      searchIds.push(...page.items.map(row => (row as any).positionId)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(searchIds, expectedPositions);
  } finally { client.release(); await c.close(); }
});

test('findMany returns a thousand-level JSON field with a result byte budget', async () => {
  const c = await setup('deep_json', 1);
  try {
    let deep: any = 'end';
    for (let i = 0; i < 1000; i++) deep = [deep];
    const first = c.rows[0];
    await c.sealed.update(c.db, c.seal, { id: first.id, scopeId: first.scope_id }, { jsonData: deep });
    const page = await c.sealed.findMany(c.db, c.seal, { scope: first.scope_id, columns: { jsonData: true },
      budgets: { resultBytes: 1000000 } });
    assert.equal(page.items.length, 1);
    let value: any = page.items[0].jsonData;
    for (let i = 0; i < 1000; i++) value = value[0];
    assert.equal(value, 'end');
  } finally { await c.close(); }
});
