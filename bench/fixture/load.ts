/** Rebuild or compare the original 100,000-row plaintext fixture on the owned disposable DB. */
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { normalizeText } from '../../src/core/search-tokens.js';
import { assertDisposable } from '../../test/disposable.js';
import { FIELDS, generate, type Table } from './generator.js';

const ORIGINAL = 'bench_realistic_100k';
const ROWS = 100_000;
const BATCH = 500;
const args = process.argv.slice(2);
let schema = ORIGINAL;
let verify = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--verify') verify = true;
  else if (args[i] === '--schema' && args[i + 1]) schema = args[++i];
  else throw new Error('Usage: load.ts [--schema <name>] [--verify]');
}
if (!/^[a-z][a-z0-9_]*$/.test(schema) || schema.length > 63) throw new Error('Invalid schema name');
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 2 });
const columns = (table: Table) => ['id', 'scope_id', 'revision', ...(table === 'tickets' ? ['customer_id'] : []), ...FIELDS.flatMap(f => [`${f}_plain`, `${f}_norm`])];
type Generated = ReturnType<typeof generate> extends Generator<infer R> ? R : never;
const values = (row: Generated) => [row.id, row.scopeId, '1', ...(row.table === 'tickets' ? [row.customerId] : []), ...FIELDS.flatMap(f => [row.data[f], normalizeText(row.data[f], 'legacy-text-v1')])];
const tuples = (count: number, width: number) => Array.from({ length: count }, (_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(',')})`).join(',');

async function compare() {
  for (const table of ['customers', 'tickets'] as const) {
    const source = generate(ROWS);
    if (table === 'tickets') for (let i = 0; i < ROWS; i++) source.next();
    const cols = columns(table);
    let after = '00000000-0000-0000-0000-000000000000';
    let matched = 0;
    while (matched < ROWS) {
      const rows = (await pool.query(`select ${cols.join(',')} from ${schema}.${table} where id > $1 order by id limit $2`, [after, BATCH])).rows;
      assert(rows.length > 0, `${table}: DB ended after ${matched} rows`);
      for (const actual of rows) {
        const next = source.next();
        assert(!next.done && next.value.table === table, `${table}: generator ended early`);
        const expected = values(next.value);
        for (let c = 0; c < cols.length; c++) assert.equal(String(actual[cols[c]]), String(expected[c]), `${table} row ${matched + 1} column ${cols[c]}`);
        matched++;
      }
      after = rows.at(-1).id;
    }
    const extra = await pool.query(`select 1 from ${schema}.${table} where id > $1 limit 1`, [after]);
    assert.equal(extra.rowCount, 0, `${table}: DB has extra rows`);
    console.log(JSON.stringify({ schema, table, matched, mismatched: 0 }));
  }
}

async function load() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`create schema ${schema}`);
    for (const table of ['customers', 'tickets'] as const) {
      const cols = columns(table);
      const definitions = ['id uuid primary key', 'scope_id uuid not null', 'revision bigint not null', ...(table === 'tickets' ? ['customer_id uuid not null'] : []), ...FIELDS.flatMap(f => [`${f}_plain text not null`, `${f}_norm text not null`]), 'unique(scope_id,id)'];
      await client.query(`create table ${schema}.${table} (${definitions.join(',')})`);
      const source = generate(ROWS);
      if (table === 'tickets') for (let i = 0; i < ROWS; i++) source.next();
      for (let offset = 0; offset < ROWS; offset += BATCH) {
        const batch: Generated[] = [];
        for (let i = 0; i < BATCH && offset + i < ROWS; i++) {
          const next = source.next();
          assert(!next.done && next.value.table === table);
          batch.push(next.value);
        }
        await client.query(`insert into ${schema}.${table} (${cols.join(',')}) values ${tuples(batch.length, cols.length)}`, batch.flatMap(values));
      }
      for (const field of FIELDS) {
        await client.query(`create index ${table}_${field}_exact on ${schema}.${table} (scope_id,${field}_norm,id)`);
        await client.query(`create index ${table}_${field}_trgm on ${schema}.${table} using gin (${field}_norm gin_trgm_ops)`);
      }
      if (table === 'tickets') await client.query(`create index tickets_customer_id_id on ${schema}.tickets (customer_id,id)`);
      await client.query(`analyze ${schema}.${table}`);
      console.log(JSON.stringify({ schema, table, loaded: ROWS }));
    }
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}

try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439, 'Wrong port');
  const exists = (await pool.query('select 1 from pg_namespace where nspname=$1', [schema])).rowCount;
  if (verify) {
    assert(exists, `Schema ${schema} does not exist`);
    await compare();
  } else {
    assert(!exists, `Refusing to load into existing schema ${schema}`);
    assert((await pool.query("select 1 from pg_extension where extname='pg_trgm'")).rowCount, 'pg_trgm is required');
    await load();
  }
} finally { await pool.end(); }
