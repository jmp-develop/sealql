import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createSealer, SealError } from '../src/index.js';
import { bindSealed, definePostgresStorage, defineSealedModel, postgresExecutor, type SealedSqlExecutor } from '../src/adapters/postgres/sealed-index.js';
import { assertDisposable } from './disposable.js';

const scopeId = '00000000-0000-4000-8000-000000000001';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function executor(pool: Pool, sqlLog: string[]): SealedSqlExecutor {
  const onClient = (client: PoolClient): SealedSqlExecutor => {
    const tx: SealedSqlExecutor = {
      query: async statement => { sqlLog.push(statement.text); const r = await client.query(statement.text, statement.values); return { rows: r.rows, rowCount: r.rowCount }; },
      transaction: fn => fn(tx),
    };
    return tx;
  };
  return postgresExecutor({
    query: async statement => { sqlLog.push(statement.text); const r = await pool.query(statement.text, statement.values); return { rows: r.rows, rowCount: r.rowCount }; },
    transaction: async fn => {
      const client = await pool.connect();
      try { await client.query('begin isolation level read committed'); const value = await fn(onClient(client)); await client.query('commit'); return value; }
      catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    },
  });
}

test('standard raw SQL CRUD, verified pages, OR semi-join and bounded count', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  const schema = `sealql_standard_${process.pid}`;
  let created = false;
  try {
    await assertDisposable(pool);
    await pool.query(`create schema "${schema}"`);
    created = true;
    const model = defineSealedModel({
      id: 'memo', identity: { scope: 'uuid', row: 'uuid', revision: 'bigint' },
      fields: { body: { type: 'text', nullable: false, search: { exact: true, substring: { wordBoundary: true }, normalizer: 'nfc-v1' } },
        amount: { type: 'integer', nullable: true, search: { exact: true } } },
      public: { status: { type: 'text', nullable: false, maxBytes: 32 } },
    });
    const { definition, storage, ddl } = definePostgresStorage(model, {
      schema, table: 'memo', identity: { scope: 'scope_id', row: 'id', revision: 'revision' },
      fields: { body: 'body_ct', amount: 'amount_ct' }, public: { status: 'status' },
    });
    assert.equal(ddl.filter(statement => /using gin\(/i.test(statement.text)).length, 1, 'one substring field has one-column GIN');
    assert.equal(ddl.filter(statement => /_bt"? on /i.test(statement.text)).length, 2, 'exact indexes remain separate');
    for (const statement of ddl) await pool.query(statement.text, statement.values);
    const indexColumns = await pool.query('select column_name from information_schema.columns where table_schema=$1 and table_name=$2', [schema, storage.index!.name]);
    assert.equal(indexColumns.rows.some(row => row.column_name === 'epoch'), false, 'companion has one row per scope and row ID');
    const sqlLog: string[] = [];
    const sealer = createSealer({ key: new Uint8Array(32).fill(7) });
    const scoped = bindSealed({ sealer, definition, storage, executor: executor(pool, sqlLog) }).forScope({ scopeId });
    for (let n = 1; n <= 30; n++) await scoped.insert({ id: id(n), data: { body: n % 3 === 0 ? 'alpha beta' : n % 2 === 0 ? 'alphabet' : 'gamma', amount: n, status: 'open' } });
    sqlLog.length = 0;
    const page = await scoped.findMany({ match: f => f.any(f.body.contains('alph'), f.body.eq('gamma')), select: { body: true }, limit: 20 });
    assert.equal(page.items.length, 20);
    assert.equal(sqlLog.length, 1);
    assert.match(sqlLog[0], / in \(\s*with sample as materialized .* quick as materialized .* fallback as materialized /is);
    assert.doesNotMatch(sqlLog[0], /exists\s*\(/i);
    assert.ok(page.items.every(row => row.body === 'alpha beta' || row.body === 'alphabet' || row.body === 'gamma'));
    const spacedLike = await scoped.findMany({ match: f => f.body.like('a lph%'), select: { body: true }, limit: 50 });
    assert.equal(spacedLike.items.length, 20, 'LIKE literals use the same whitespace folding as indexed values');
    const alphaIds: string[] = [];
    let alphaCursor: string | null = null;
    do {
      const alphaPage: Awaited<ReturnType<typeof scoped.findMany>> =
        await scoped.findMany({ match: f => f.body.contains('alpha'), select: { body: true }, limit: 7, cursor: alphaCursor ?? undefined });
      alphaIds.push(...alphaPage.items.map(row => { assert.match(String(row.body), /^alpha/); return String(row.id); }));
      alphaCursor = alphaPage.nextCursor;
    } while (alphaCursor);
    assert.deepEqual(alphaIds, Array.from({ length: 30 }, (_, i) => i + 1).filter(n => n % 3 === 0 || n % 2 === 0).map(id));
    await assert.rejects(scoped.findMany({ match: f => f.body.like('a   %'), limit: 20 }), (e: unknown) => e instanceof SealError && e.code === 'QUERY_TOO_BROAD');
    const second = await scoped.findMany({ match: f => f.any(f.body.contains('alph'), f.body.eq('gamma')), select: { body: true }, limit: 20, cursor: page.nextCursor! });
    assert.equal(second.items.length, 10);
    assert.equal(new Set([...page.items, ...second.items].map(row => row.id)).size, 30);
    const originalOpen = sealer.open.bind(sealer);
    let activeAmounts = 0, maxActiveAmounts = 0, amountCalls = 0;
    sealer.open = async (...args) => {
      if (args[1].fieldId !== 'amount') return originalOpen(...args);
      amountCalls++; activeAmounts++; maxActiveAmounts = Math.max(maxActiveAmounts, activeAmounts);
      try { await new Promise(resolve => setTimeout(resolve, 1)); return await originalOpen(...args); }
      finally { activeAmounts--; }
    };
    try {
      const projected = await scoped.findMany({ match: f => f.any(f.body.contains('alph'), f.body.eq('gamma')), select: { amount: true }, limit: 20 });
      assert.equal(projected.items.length, 20);
      assert.ok(maxActiveAmounts > 1, 'projected rows should authenticate concurrently');
      assert.equal(amountCalls, 20, 'candidates after the page limit must not project');
      activeAmounts = 0; maxActiveAmounts = 0; amountCalls = 0;
      await scoped.findMany({ match: f => f.any(f.body.contains('alph'), f.body.eq('gamma')), select: { amount: true }, limit: 20, budgets: { decryptConcurrency: 1 } });
      assert.equal(maxActiveAmounts, 1);
      assert.equal(amountCalls, 20);
    } finally { sealer.open = originalOpen; }
    const joined = (await pool.query(`select scope_id as scope, id, revision, body_ct as body, amount_ct as amount from "${schema}"."memo" order by id`)).rows;
    joined.push({ ...joined[0] });
    let activeJoined = 0, maxActiveJoined = 0, joinedCalls = 0;
    sealer.open = async (...args) => {
      joinedCalls++; activeJoined++; maxActiveJoined = Math.max(maxActiveJoined, activeJoined);
      try { await new Promise(resolve => setTimeout(resolve, 1)); return await originalOpen(...args); }
      finally { activeJoined--; }
    };
    try {
      const mapping = { scope: 'scope', row: 'id', revision: 'revision', fields: { body: 'body', amount: 'amount' } };
      const decrypted = await scoped.decryptRows({ rows: joined, mapping, select: { body: true, amount: true } });
      assert.equal(decrypted.length, 31);
      assert.deepEqual(decrypted[0], decrypted[30]);
      assert.ok(maxActiveJoined > 4, 'JOIN fields across all rows should decrypt concurrently');
      assert.equal(joinedCalls, 60, 'duplicate JOIN rows should reuse authenticated values');
      activeJoined = 0; maxActiveJoined = 0; joinedCalls = 0;
      await scoped.decryptRows({ rows: joined, mapping, select: { body: true, amount: true }, budgets: { decryptConcurrency: 2 } });
      assert.equal(maxActiveJoined, 2);
      assert.equal(joinedCalls, 60);
      await assert.rejects(scoped.decryptRows({ rows: joined, mapping, select: { body: true, amount: true }, budgets: { resultBytes: 1 } }),
        (e: unknown) => e instanceof SealError && e.code === 'LIMIT_EXCEEDED');
      await assert.rejects(scoped.decryptRows({ rows: joined, mapping, select: { body: true, amount: true }, budgets: { decryptedBytes: 1 } }),
        (e: unknown) => e instanceof SealError && e.code === 'LIMIT_EXCEEDED');
    } finally { sealer.open = originalOpen; }
    const budgetIds: string[] = [];
    let budgetCursor: string | undefined;
    for (let n = 0; n < 100; n++) {
      const budgetPage = await scoped.findMany({ match: f => f.any(f.body.contains('alph'), f.body.eq('gamma')), select: { amount: true }, limit: 20, cursor: budgetCursor, budgets: { resultBytes: 700 } });
      budgetIds.push(...budgetPage.items.map(row => row.id));
      if (!budgetPage.nextCursor) break;
      assert.equal(budgetPage.stopReason, 'budget-exceeded');
      budgetCursor = budgetPage.nextCursor;
    }
    assert.equal(budgetIds.length, 30);
    assert.equal(new Set(budgetIds).size, 30);
    await assert.rejects(scoped.count({ match: f => f.body.contains('alph'), maxCandidates: 5 }), (e: unknown) => e instanceof SealError && e.code === 'LIMIT_EXCEEDED');
    const total = await scoped.count({ match: f => f.body.contains('alph'), maxCandidates: 50 });
    assert.equal(total, 20);
    const first = await scoped.get({ id: id(1) }); assert.equal(first?.body, 'gamma');
    await scoped.update({ id: id(1), expectedRevision: 1n, patch: { body: 'alpha beta' } });
    await assert.rejects(scoped.update({ id: id(1), expectedRevision: 1n, patch: { body: 'stale' } }), (e: unknown) => e instanceof SealError && e.code === 'WRITE_CONFLICT');
    assert.equal((await scoped.findMany({ match: f => f.body.eq('alpha beta'), limit: 50 })).items.length, 11);
    await scoped.delete({ id: id(1), expectedRevision: 2n });
    assert.equal((await scoped.findMany({ match: f => f.body.eq('alpha beta'), limit: 50 })).items.length, 10);
    const before = (await scoped.findMany({ match: f => f.body.eq('gamma'), limit: 50 })).items.length;
    await scoped.insert({ id: id(31), data: { body: 'gamma', amount: 31, status: 'open' } });
    assert.equal((await scoped.findMany({ match: f => f.body.eq('gamma'), limit: 50 })).items.length, before + 1);
    const companion = storage.index!;
    const indexProfiles = companion.profiles!;
    const previousIndex = (await pool.query(`select * from "${schema}"."${companion.name}" where scope_id=$1 and row_id=$2`, [scopeId, id(2)])).rows[0];
    await scoped.update({ id: id(2), expectedRevision: 1n, patch: { body: 'gamma' } });
    assert.equal((await scoped.findMany({ match: f => f.body.eq('gamma'), limit: 50 })).items.length, before + 2);
    assert.equal((await scoped.findMany({ match: f => f.body.eq('alphabet'), limit: 50 })).items.some(row => row.id === id(2)), false);
    assert.equal((await scoped.findMany({ match: f => f.all(f.body.eq('gamma'), f.amount.eq(2)), limit: 50 })).items.some(row => row.id === id(2)), true, 'partial update preserves AND search');
    const currentIndex = (await pool.query(`select * from "${schema}"."${companion.name}" where scope_id=$1 and row_id=$2`, [scopeId, id(2)])).rows[0];
    assert.notDeepEqual(currentIndex[indexProfiles['body/exact'].tokens], previousIndex[indexProfiles['body/exact'].tokens]);
    assert.deepEqual(currentIndex[indexProfiles['amount/exact'].tokens], previousIndex[indexProfiles['amount/exact'].tokens]);
    await scoped.update({ id: id(2), expectedRevision: 2n, patch: { amount: null } });
    const nulled = (await pool.query(`select * from "${schema}"."${companion.name}" where scope_id=$1 and row_id=$2`, [scopeId, id(2)])).rows[0];
    assert.equal(nulled[indexProfiles['amount/exact'].tokens], null);
    assert.ok(nulled[indexProfiles['body/exact'].tokens]?.length > 0);
    const oneRow = await pool.query(`select 1 from "${schema}"."${companion.name}" where scope_id=$1 and row_id=$2`, [scopeId, id(2)]);
    assert.equal(oneRow.rowCount, 1);
  } finally {
    if (created) await pool.query(`drop schema "${schema}" cascade`);
    await pool.end();
  }
});

test('high false-positive pages grow candidate batches without losing cursor order', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  const schema = `sealql_batch_${process.pid}`;
  let created = false;
  try {
    await assertDisposable(pool);
    await pool.query(`create schema "${schema}"`);
    created = true;
    const model = defineSealedModel({
      id: 'batch-probe', identity: { scope: 'uuid', row: 'uuid', revision: 'bigint' },
      fields: { body: { type: 'text', nullable: false, search: { substring: {} } } },
    });
    const { definition, storage, ddl } = definePostgresStorage(model, {
      schema, table: 'memo', identity: { scope: 'scope_id', row: 'id', revision: 'revision' }, fields: { body: 'body_ct' },
    });
    for (const statement of ddl) await pool.query(statement.text, statement.values);
    const sqlLog: string[] = [];
    const scoped = bindSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(8) }), definition, storage, executor: executor(pool, sqlLog) }).forScope({ scopeId });
    const expected: string[] = [];
    for (let n = 1; n <= 220; n++) {
      const hit = n % 22 === 0;
      if (hit) expected.push(id(n));
      await scoped.insert({ id: id(n), data: { body: hit ? 'needle phrase' : 'different phrase' } });
    }
    // Force token false positives while keeping the authenticated plaintext distinct.
    const index = storage.index!;
    const tokens = index.profiles!['body/substring'].tokens;
    const table = `"${schema}"."${index.name}"`;
    await pool.query(`update ${table} as target set "${tokens}" = source."${tokens}" from ${table} as source where source.row_id=$1 and target.scope_id=$2 and target.row_id<>source.row_id`, [id(22), scopeId]);

    sqlLog.length = 0;
    const first = await scoped.findMany({ match: f => f.body.contains('needle'), select: { body: true }, limit: 8, budgets: { batch: 500 } });
    assert.deepEqual(first.items.map(row => row.id), expected.slice(0, 8));
    assert.ok(sqlLog.length <= 4, `expected adaptive batching, got ${sqlLog.length} SQL calls`);
    assert.match(sqlLog[0], /with sample as materialized/i);
    assert.ok(sqlLog.some(sql => !/with sample as materialized/i.test(sql)), 'batch above 200 must use the direct candidate path');
    assert.equal(first.stopReason, 'page-full');
    const second = await scoped.findMany({ match: f => f.body.contains('needle'), select: { body: true }, limit: 8, cursor: first.nextCursor!, budgets: { batch: 500 } });
    assert.deepEqual(second.items.map(row => row.id), expected.slice(8));
    assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.items, ...second.items].map(row => row.body), Array(10).fill('needle phrase'));
  } finally {
    if (created) await pool.query(`drop schema "${schema}" cascade`);
    await pool.end();
  }
});

test('multicolumn substring GIN preserves managed writes, cursor search, and count', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  const schema = `sealql_multi_${process.pid}`;
  let created = false;
  try {
    await assertDisposable(pool);
    await pool.query(`create schema "${schema}"`); created = true;
    const model = defineSealedModel({
      id: 'multi-probe', identity: { scope: 'uuid', row: 'uuid', revision: 'bigint' },
      fields: {
        body: { type: 'text', nullable: false, search: { exact: true, substring: true } },
        address: { type: 'text', nullable: false, search: { substring: true } },
      },
    });
    const { definition, storage, ddl } = definePostgresStorage(model, {
      schema, table: 'memo', identity: { scope: 'scope_id', row: 'id', revision: 'revision' },
      fields: { body: 'body_ct', address: 'address_ct' },
    });
    const gin = ddl.filter(statement => /using gin\(/i.test(statement.text));
    assert.equal(gin.length, 1);
    assert.equal((gin[0].text.match(/tokens_[a-f0-9]{16}/g) ?? []).length, 2);
    assert.equal(ddl.filter(statement => /set statistics 1000/i.test(statement.text)).length, 2);
    for (const statement of ddl) await pool.query(statement.text, statement.values);
    const indexRows = (await pool.query('select indexdef from pg_indexes where schemaname=$1 and tablename=$2 and indexdef like $3', [schema, storage.index!.name, '%USING gin%'])).rows;
    assert.equal(indexRows.length, 1);
    const repo = bindSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(21) }), definition, storage, executor: executor(pool, []) }).forScope({ scopeId });
    for (let n=1;n<=12;n++) await repo.insert({ id:id(n), data:{body:n<=9?'alpha note':'other note',address:n%2?'river road':'forest road'} });
    const matched: string[]=[];let cursor: string|null=null;
    do {
      const page: Awaited<ReturnType<typeof repo.findMany>>=await repo.findMany({match:f=>f.all(f.body.contains('alpha'),f.address.contains('river')),select:{body:true,address:true},limit:2,cursor:cursor??undefined});
      matched.push(...page.items.map(row=>{assert.equal(row.body,'alpha note');assert.equal(row.address,'river road');return String(row.id)}));
      cursor=page.nextCursor;
    } while(cursor);
    assert.deepEqual(matched,[1,3,5,7,9].map(id));
    assert.equal(await repo.count({match:f=>f.all(f.body.contains('alpha'),f.address.contains('river')),maxCandidates:50}),5);
    await repo.update({id:id(1),expectedRevision:1n,patch:{body:'changed note'}});
    assert.deepEqual((await repo.findMany({match:f=>f.all(f.body.contains('alpha'),f.address.contains('river')),limit:20})).items.map(row=>row.id),[3,5,7,9].map(id));
    assert.deepEqual((await repo.findMany({match:f=>f.all(f.body.contains('changed'),f.address.contains('river')),limit:20})).items.map(row=>row.id),[id(1)]);
    await repo.delete({id:id(3),expectedRevision:1n});
    assert.equal(await repo.count({match:f=>f.all(f.body.contains('alpha'),f.address.contains('river')),maxCandidates:50}),3);
  } finally {
    if (created) await pool.query(`drop schema "${schema}" cascade`);
    await pool.end();
  }
});
