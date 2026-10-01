import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getTableColumns, SQL } from 'drizzle-orm';
import { PgDialect, getTableConfig, pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealer, validateField, profiles, searchPieces, searchTokens } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { registrationOf } from '../src/adapters/drizzle/v0.45/native.js';
import { descriptorBytes } from '../src/core/search-tokens.js';
import { profileColumns } from '../src/core/sealed-model.js';
import { compileSearch } from '../src/core/search-predicate.js';
import { candidateRows, boundedCandidatePredicate } from '../src/core/candidate-sql.js';
import type { Node } from '../src/core/sql-fragment.js';
import { stampMigrationSql } from '../src/core/stamp-sql.js';

const render = (node: Node): string => node.kind === 'literal' ? node.text : node.kind === 'identifier'
  ? node.names.map(name => `"${name}"`).join('.') : node.kind === 'param' ? '?' : node.nodes.map(render).join('');

test('hardened validates through validateField and never derives candidate tokens', async () => {
  for (const spec of [
    { type: 'text', hardened: true }, { type: 'text', hardened: true, search: false },
    { type: 'text', hardened: false, search: { exact: true } },
    { type: 'boolean', hardened: true, search: { exact: true } },
    ...['boolean', 'instant', 'json', 'bytes'].map(type => ({ type, hardened: true, search: false })),
  ]) {
    assert.throws(() => validateField(spec as never), { code: 'INVALID_SCHEMA' });
    assert.throws(() => profiles('rows', 'field', spec as never), { code: 'INVALID_SCHEMA' });
  }
  assert.throws(() => profiles('rows', 'field', { type: 'text', hardened: true }), { code: 'INVALID_SCHEMA' });
  const ring = createSealer({ key: new Uint8Array(32).fill(93) }).ring('rows');
  for (const spec of [{ type: 'text', search: { exact: true, substring: true } },
    { type: 'integer', search: { exact: true } }, { type: 'bigint', search: { exact: true } },
    { type: 'decimal', precision: 9, scale: 2, search: { exact: true } }] as const) {
    validateField({ ...spec, hardened: true });
    const ordinary = profiles('rows', 'field', spec), hardened = profiles('rows', 'field', { ...spec, hardened: true });
    assert.equal(ordinary.length, hardened.length);
    for (let i = 0; i < ordinary.length; i++) {
      assert.deepEqual(descriptorBytes(ordinary[i]), descriptorBytes(hardened[i]));
      for (const pieces of [[], [new Uint8Array([1, 2])]])
        await assert.rejects(searchTokens(ring, 'scope', hardened[i], pieces), { code: 'UNSUPPORTED_SEARCH' });
    }
  }
});

test('hardened stores only ordinary proofs and applies them on companion and bounded SQL', async () => {
  const sealer = createSealer({ key: new Uint8Array(32).fill(93) }), sealed = createSealed({ sealer });
  const table = pgSchema('test_hardened_layout').table('rows', { id: uuid('id').primaryKey(),
    body: sealed.text('body', { hardened: true, search: { exact: true, substring: true } }),
    other: sealed.text('other', { search: { exact: true, substring: true } }),
  });
  const seal = sealed.register(table, { row: 'id' }), reg = registrationOf(seal), config = getTableConfig(seal), dialect = new PgDialect();
  const mapped = reg.storage.index!.profiles!;
  assert.equal(mapped['body/exact'].tokens, undefined);
  assert.equal(mapped['body/substring'].tokens, undefined);
  assert.equal(profileColumns(mapped['body/exact']).length, 2);
  assert.equal(profileColumns(mapped['body/substring']).length, 4);
  assert.equal(Object.keys(getTableColumns(seal)).filter(key => key.startsWith('tokens_')).length, 2);
  assert.equal(config.indexes.filter(i => i.config.method === 'gin').length, 1);
  const gin = config.indexes.find(i => i.config.method === 'gin')!;
  assert.equal(gin.config.columns.length, 1);
  const migrations = sealed.extraMigrationSql(seal);
  assert.deepEqual(migrations.slice(0, stampMigrationSql('test_hardened_layout').length), stampMigrationSql('test_hardened_layout'));
  assert.equal(migrations.filter(statement => statement.includes('set statistics')).length, 1);
  assert.equal(migrations.filter(statement => statement.includes('set storage main')).length, 6);
  const stored = Object.entries(reg.definition.fields).flatMap(([key, spec]) => profiles(reg.model, key, spec));
  for (const op of ['eq', 'contains', 'startsWith', 'endsWith', 'like'] as const) {
    const search = await compileSearch({ op, field: 'body', value: op === 'like' ? '%ab_cd%ef%' : 'abcdefgh' }, reg.definition, stored, sealer.ring(reg.model), '_');
    assert.equal(search.op, 'leaf'); if (search.op !== 'leaf') throw Error('leaf');
    assert.deepEqual(search.leaf.tokens, []);
    assert.ok(search.leaf.proof.keys.length > 0);
    assert.doesNotMatch(render(candidateRows(reg.storage, '_', search).node), /tokens_|@>/);
    const bounded = render(boundedCandidatePredicate(reg.definition, reg.storage, '_', search, 1).node);
    assert.doesNotMatch(bounded, /tokens_|@>/);
    assert.match(bounded, /and true/);
    assert.match(bounded, op === 'eq' ? /pg_catalog.sha256/ : /sealql_match/);
  }
  const where = await sealed.where(seal, { match: m => m.and(m.body.contains('ab'), m.other.eq('cd')) });
  assert.match(dialect.sqlToQuery(where).sql, /tokens_/);
  assert.match(dialect.sqlToQuery(where).sql, /sealql_match_positions/);
  await assert.rejects(sealed.where(seal, { match: m => m.body.contains('a') }), { code: 'QUERY_TOO_BROAD' });
  await assert.rejects(sealed.where(seal, { match: m => m.body.like('%a%') }), { code: 'QUERY_TOO_BROAD' });
  for (const p of stored.filter(p => p.hardened)) {
    await assert.rejects(searchTokens(sealer.ring(reg.model), '_', p, searchPieces(p, 'abcdefgh')), { code: 'UNSUPPORTED_SEARCH' });
  }
  assert.ok(config.checks.every(c => c.value instanceof SQL));
});
