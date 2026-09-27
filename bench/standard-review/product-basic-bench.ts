import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Pool, type PoolClient } from 'pg';
import { createSealer } from '../../src/index.js';
import { bindSealed, definePostgresStorage, defineSealedModel, postgresExecutor, type SealedSqlExecutor } from '../../src/adapters/postgres/sealed-index.js';
import { assertDisposable } from '../../test/disposable.js';

const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
const schema = `sealql_basic_bench_${process.pid}`;
const scopeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const queryStats = { calls: 0, ms: 0, candidates: 0 };
const timed = async (query: () => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>) => {
  const start = performance.now();
  const result = await query();
  queryStats.calls++;
  queryStats.ms += performance.now() - start;
  queryStats.candidates += result.rows.length;
  return result;
};
function executor(): SealedSqlExecutor {
  const onClient = (client: PoolClient): SealedSqlExecutor => {
    const tx: SealedSqlExecutor = { query: statement => timed(() => client.query(statement.text, statement.values)), transaction: fn => fn(tx) };
    return tx;
  };
  return postgresExecutor({
    query: statement => timed(() => pool.query(statement.text, statement.values)),
    transaction: async fn => {
      const client = await pool.connect();
      try { await client.query('begin'); const result = await fn(onClient(client)); await client.query('commit'); return result; }
      catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    },
  });
}
let created = false;
try {
  await assertDisposable(pool);
  const source = (await pool.query(`select id, name_plain, phone_plain, address_plain, memo_plain, email_plain, company_plain from bench_realistic_100k.customers where scope_id=$1 order by id limit 1000`, [scopeId])).rows;
  if (source.length !== 1000) throw new Error(`Expected 1000 source rows, got ${source.length}`);
  await pool.query(`create schema "${schema}"`); created = true;
  const model = defineSealedModel({
    id: 'basic-bench', identity: { scope: 'uuid', row: 'uuid', revision: 'bigint' },
    fields: {
      name: { type: 'text', nullable: false },
      phone: { type: 'text', nullable: false },
      address: { type: 'text', nullable: false, search: { substring: true } },
      memo: { type: 'text', nullable: false, search: { substring: true } },
      email: { type: 'text', nullable: false },
      company: { type: 'text', nullable: false, search: { substring: true } },
    }, public: {},
  });
  const { definition, storage, ddl } = definePostgresStorage(model, {
    schema, table: 'sealed', identity: { scope: 'scope_id', row: 'id', revision: 'revision' },
    fields: { name: 'name_ct', phone: 'phone_ct', address: 'address_ct', memo: 'memo_ct', email: 'email_ct', company: 'company_ct' }, public: {},
  });
  for (const statement of ddl) await pool.query(statement.text, statement.values);
  await pool.query(`create table "${schema}".plain (id uuid primary key, name text not null, phone text not null, address text not null, memo text not null, email text not null, company text not null)`);
  const keySettings = { key: new Uint8Array(32).fill(42) } as const;
  const writer = bindSealed({ sealer: createSealer(keySettings), definition, storage, executor: executor() }).forScope({ scopeId });
  for (const row of source) {
    await writer.insert({ id: row.id, data: { name: row.name_plain, phone: row.phone_plain, address: row.address_plain, memo: row.memo_plain, email: row.email_plain, company: row.company_plain } });
    await pool.query(`insert into "${schema}".plain (id,name,phone,address,memo,email,company) values ($1,$2,$3,$4,$5,$6,$7)`, [row.id, row.name_plain, row.phone_plain, row.address_plain, row.memo_plain, row.email_plain, row.company_plain]);
  }
  await pool.query(`analyze "${schema}".sealed`);
  await pool.query(`analyze "${schema}".plain`);
  const cases = [
    { field: 'address' as const, term: '세종대로', projection: 'three' as const },
    { field: 'address' as const, term: '세종대로', projection: 'six' as const },
    { field: 'memo' as const, term: '서비스', projection: 'three' as const },
    { field: 'company' as const, term: '서울', projection: 'three' as const },
    { field: 'memo' as const, term: '없는검색어', projection: 'three' as const },
  ];
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const report = [];
  for (const item of cases) {
    const projectedFields = item.projection === 'six' ? ['name', 'phone', 'address', 'memo', 'email', 'company'] : ['address', 'memo', 'company'];
    const plainSql = `select id, ${projectedFields.join(', ')} from "${schema}".plain where ${item.field} like $1 order by id limit 20`;
    const reader = bindSealed({ sealer: createSealer(keySettings), definition, storage, executor: executor() }).forScope({ scopeId });
    const runPlain = async () => {
      const start = performance.now();
      const rows = (await pool.query(plainSql, [`%${item.term}%`])).rows;
      const ms = performance.now() - start;
      return { sqlMs: ms, totalMs: ms, returned: rows.length, ids: rows.map(row => row.id as string) };
    };
    const runSealed = async () => {
      queryStats.calls = 0; queryStats.ms = 0; queryStats.candidates = 0;
      const start = performance.now();
      const select = Object.fromEntries(projectedFields.map(field => [field, true]));
      const page = await reader.findMany({ match: f => f[item.field].contains(item.term), select, limit: 20 });
      return { sqlMs: queryStats.ms, totalMs: performance.now() - start, sqlCalls: queryStats.calls, candidates: queryStats.candidates, returned: page.items.length, authenticatedFieldsEstimated: queryStats.candidates + (projectedFields.length - 1) * page.items.length, stopReason: page.stopReason, ids: page.items.map(row => row.id) };
    };
    const firstSealed = await runSealed();
    const firstPlain = await runPlain();
    if (JSON.stringify(firstPlain.ids) !== JSON.stringify(firstSealed.ids)) throw new Error(`First-call mismatch for ${item.field}:${item.term}`);
    for (let i = 0; i < 2; i++) { await runPlain(); await runSealed(); }
    const plainRuns = [], sealedRuns = [];
    for (let i = 0; i < 7; i++) {
      const plainFirst = i % 2 === 0;
      const first = plainFirst ? await runPlain() : await runSealed();
      const second = plainFirst ? await runSealed() : await runPlain();
      const plain = plainFirst ? first as Awaited<ReturnType<typeof runPlain>> : second as Awaited<ReturnType<typeof runPlain>>;
      const sealed = plainFirst ? second as Awaited<ReturnType<typeof runSealed>> : first as Awaited<ReturnType<typeof runSealed>>;
      if (JSON.stringify(plain.ids) !== JSON.stringify(sealed.ids)) throw new Error(`Measured-run mismatch for ${item.field}:${item.term}`);
      plainRuns.push(plain); sealedRuns.push(sealed);
    }
    report.push({ ...item,
      firstCall: { plain: { sqlMs: firstPlain.sqlMs, totalMs: firstPlain.totalMs }, sealed: { sqlMs: firstSealed.sqlMs, totalMs: firstSealed.totalMs } },
      warmMedian: { plain: { sqlMs: median(plainRuns.map(run => run.sqlMs)), totalMs: median(plainRuns.map(run => run.totalMs)), returned: plainRuns[0].returned },
        sealed: { sqlMs: median(sealedRuns.map(run => run.sqlMs)), totalMs: median(sealedRuns.map(run => run.totalMs)), sqlCalls: sealedRuns[0].sqlCalls, candidates: sealedRuns[0].candidates, returned: sealedRuns[0].returned, authenticatedFieldsEstimated: sealedRuns[0].authenticatedFieldsEstimated, stopReason: sealedRuns[0].stopReason } },
      runs: { plain: plainRuns.map(({ ids, ...run }) => run), sealed: sealedRuns.map(({ ids, ...run }) => run) },
    });
  }
  const output = { fixture: '1000 read-only derived rows from bench_realistic_100k.customers in a separate disposable schema', scopeId, cases: report, notes: ['First-call standard timing uses a fresh reader with cold derived-key and token-profile caches; database buffers may already be warm from fixture insertion.', 'Each case has two unreported warmup pairs followed by seven measured pairs, alternating which path runs first; warmMedian is the median of seven SQL and total times separately.', 'Authenticated field counts are computed from the engine path: one predicate field per candidate plus other projected fields per returned row. They are estimates, not instrumentation.', 'The plaintext SQL and standard calls use the same rows, predicate terms, ID order, 20-row limit, and corresponding three- or six-field projection.', 'This local microbenchmark is not a production write measurement.'] };
  const path = 'bench/results/standard-product-basic-bench-fixed-key-2026-09-27.json';
  await writeFile(path, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output));
} finally {
  if (created) await pool.query(`drop schema "${schema}" cascade`);
  await pool.end();
}
