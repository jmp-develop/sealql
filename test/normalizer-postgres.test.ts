import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { createSealer } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { assertDisposable } from './disposable.js';

// Independent references: the default rule folds case and ignores whitespace; 'digits' also ignores - ( ) . and a leading +; 'keep-spaces' keeps whitespace for exact match only.
const fold = (v: string) => v.normalize('NFC').toLowerCase();
const compact = (v: string) => fold(v).replace(/\s/g, '');
const digits = (v: string) => compact(v).replace(/[-().]/g, '').replace(/^\+/, '');

test('digits and keep-spaces normalizers match references on ordinary and hardened fields', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  const schemaName = 'test_normalizers';
  let created = false;
  try {
    await assertDisposable(pool);
    assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
    assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1', [schemaName])).rowCount, 0);
    const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(57) }) });
    const rows = pgSchema(schemaName).table('rows', {
      id: uuid('id').primaryKey(),
      phone: sealed.text('phone', { search: { exact: true, substring: true, normalizer: 'digits' } }),
      phoneH: sealed.text('phone_h', { hardened: true, search: { exact: true, substring: true, normalizer: 'digits' } }),
      name: sealed.text('name', { search: { exact: true, substring: true } }),
      nameK: sealed.text('name_k', { search: { exact: true, substring: true, normalizer: 'keep-spaces' } }),
      nameKH: sealed.text('name_kh', { hardened: true, search: { exact: true, substring: true, normalizer: 'keep-spaces' } }),
    });
    const seal = sealed.register(rows, { row: 'id' });
    await pool.query(`create schema "${schemaName}"`); created = true;
    for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson({ rows, seal }))) await pool.query(s);
    for (const s of sealed.extraMigrationSql(seal)) await pool.query(s);
    const db = drizzle(pool);
    const fixture = (await pool.query('select id,phone_plain,name_plain from bench_realistic_100k.customers order by id limit 12')).rows;
    // Derived variants: the same phone with and without separators, and the same name with and without spaces.
    const inputs = fixture.flatMap((f, i) => {
      const phone = i % 2 ? `+(${f.phone_plain})` : f.phone_plain.replace(/-/g, '');
      const spaced = { id: f.id as string, phone, phoneH: phone, name: f.name_plain, nameK: f.name_plain, nameKH: f.name_plain };
      const joined = f.name_plain.replace(/\s/g, '');
      return [spaced, { ...spaced, id: crypto.randomUUID(), name: joined, nameK: joined, nameKH: joined }];
    });
    await sealed.insert(db, seal, inputs);
    const count = (match: (m: any) => any) => sealed.count(db, seal, { match });
    for (const f of fixture.slice(0, 4)) {
      const hyphen = f.phone_plain as string, bare = digits(hyphen), middle = hyphen.slice(1, 7);
      const want = (q: string, op: (v: string, q: string) => boolean) => inputs.filter(r => op(digits(r.phone), digits(q))).length;
      for (const field of ['phone', 'phoneH'] as const) {
        assert.equal(await count(m => m[field].eq(hyphen)), want(hyphen, (v, q) => v === q));
        assert.equal(await count(m => m[field].eq(bare)), want(bare, (v, q) => v === q));
        assert.equal(await count(m => m[field].contains(middle)), want(middle, (v, q) => v.includes(q)));
        assert.equal(await count(m => m[field].like(`%${hyphen.slice(-6)}`)), want(hyphen.slice(-6), (v, q) => v.endsWith(q)));
      }
      const name = f.name_plain as string, joined = name.replace(/\s/g, '');
      assert.equal(await count(m => m.name.eq(name)), inputs.filter(r => compact(r.name) === compact(name)).length);
      for (const field of ['nameK', 'nameKH'] as const) {
        assert.equal(await count(m => m[field].eq(name)), inputs.filter(r => fold(r.nameK) === fold(name)).length);
        assert.equal(await count(m => m[field].eq(joined)), inputs.filter(r => fold(r.nameK) === fold(joined)).length);
        assert.equal(await count(m => m[field].contains(joined.slice(1))), inputs.filter(r => compact(r.nameK).includes(compact(joined.slice(1)))).length);
      }
      assert.ok(await count(m => m.name.eq(name)) > await count(m => m.nameK.eq(name)));
    }
    const page = await sealed.findMany(db, seal, { match: m => m.phoneH.contains(fixture[0].phone_plain.slice(-9)), limit: 20 });
    assert.ok(page.items.length >= 2);
    // The original input format is stored and returned unchanged; only search ignores separators.
    for (const r of page.items) assert.equal(r.phoneH, inputs.find(i => i.id === r.id)!.phoneH);
    await assert.rejects(sealed.insert(db, seal, [{ ...inputs[0], id: crypto.randomUUID(), phone: '010-1234-5678 ext' }]), { code: 'INVALID_VALUE' });
  } finally {
    if (created) await pool.query(`drop schema "${schemaName}" cascade`);
    await pool.end();
  }
});
