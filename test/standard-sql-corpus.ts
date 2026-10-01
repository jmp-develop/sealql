import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PgDialect, getTableConfig, pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { registrationOf } from '../src/adapters/drizzle/v0.45/native.js';
import { compileSearch, type SearchNode } from '../src/core/search-predicate.js';
import { profiles, descriptorBytes } from '../src/core/search-tokens.js';
import { candidateRows, candidatePredicate, boundedCandidatePredicate } from '../src/core/candidate-sql.js';
import { type Node } from '../src/core/sql-fragment.js';

/** Deterministic SQL and parameter corpus, captured before hardened existed. */
export async function standardSqlCorpus() {
  const sealer = createSealer({ key: new Uint8Array(32).fill(72) });
  const sealed = createSealed({ sealer });
  const schema = pgSchema('test_standard_sql_bytes');
  const parent = schema.table('rows', {
    id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), status: text('status').notNull(),
    body: sealed.text('body', { search: { exact: true, substring: true } }),
    other: sealed.text('other', { search: { substring: { skipGrams: false } } }),
    amount: sealed.integer('amount', { search: { exact: { bits: 2 } } }),
    large: sealed.bigint('large', { search: { exact: true } }),
    price: sealed.decimal('price', { precision: 10, scale: 2, search: { exact: true } }),
  });
  const seal = sealed.register(parent, { row: 'id', scope: 'scopeId' }), reg = registrationOf(seal);
  const scopeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const stored = Object.entries(reg.definition.fields).flatMap(([key, spec]) => profiles(reg.model, key, spec));
  const leaves: SearchNode[] = [
    { op: 'eq', field: 'body', value: '' }, { op: 'eq', field: 'body', value: 'A' },
    { op: 'eq', field: 'body', value: 'abcdefghijklmnop' },
    { op: 'contains', field: 'body', value: 'abcdefghijklmnop' },
    { op: 'startsWith', field: 'body', value: 'ab' }, { op: 'endsWith', field: 'body', value: 'abcdef' },
    ...['%abcdef%', 'abcdef%', '%abcdef', 'abcdef', '%ab_cd%ef%', '%ab\\%cd%ef%', '%ab\\_cd%'].map(value => ({ op: 'like' as const, field: 'body', value })),
    { op: 'contains', field: 'other', value: 'abcde' }, { op: 'eq', field: 'amount', value: 7 },
    { op: 'eq', field: 'large', value: 9007199254740993n }, { op: 'eq', field: 'price', value: '12.30' },
  ];
  const corpus: unknown[] = [];
  const render = (node: Node): { sql: string; params: unknown[] } => {
    const params: unknown[] = [];
    const visit = (part: Node): string => {
      if (part.kind === 'literal') return part.text;
      if (part.kind === 'identifier') return part.names.map(name => `"${name.replaceAll('"', '""')}"`).join('.');
      if (part.kind === 'param') { params.push(part.value); return `$${params.length}`; }
      return part.nodes.map(visit).join('');
    };
    return { sql: visit(node), params };
  };
  const nodes = [...leaves, { op: 'all' as const, children: [leaves[3], leaves[14]] },
    { op: 'any' as const, children: [leaves[2], leaves[13]] },
    { op: 'all' as const, children: [{ op: 'any' as const, children: [leaves[0], leaves[3]] }, leaves[14]] }];
  for (const node of nodes) {
    const compiled = await compileSearch(node, reg.definition, stored, sealer.ring(reg.model), scopeId);
    corpus.push(...[candidateRows(reg.storage, scopeId, compiled), candidatePredicate(reg.definition, reg.storage, scopeId, compiled),
      boundedCandidatePredicate(reg.definition, reg.storage, scopeId, compiled, 19),
      boundedCandidatePredicate(reg.definition, reg.storage, scopeId, compiled, 301, '00000000-0000-4000-8000-000000000123')].map(fragment => render(fragment.node)));
  }
  const dialect = new PgDialect();
  for (const match of [
    (m: any) => m.body.contains('abcdefghijklmnop'),
    (m: any) => m.and(m.body.eq('alpha'), m.sql(sql`${parent.status}='active'`)),
    (m: any) => m.or(m.body.like('%ab_cd%ef%'), m.other.contains('abcde')),
  ]) corpus.push(dialect.sqlToQuery(await sealed.where(seal, { scope: scopeId, match })));
  const table = getTableConfig(reg.index);
  corpus.push({ columns: table.columns.map(c => [c.name, c.getSQLType(), c.notNull]),
    checks: table.checks.map(c => [c.name, dialect.sqlToQuery(c.value)]),
    indexes: table.indexes.map(i => ({ name: i.config.name, unique: i.config.unique, method: i.config.method,
      columns: i.config.columns.map(c => 'getSQL' in c && typeof c.getSQL === 'function' ? dialect.sqlToQuery(c.getSQL()) : 'name' in c ? c.name : c) })) });
  corpus.push(sealed.extraMigrationSql(seal), stored.map(p => Buffer.from(descriptorBytes(p)).toString('hex')));
  const json = JSON.stringify(corpus, (_key, value) => typeof value === 'bigint' ? { bigint: String(value) }
    : value instanceof Uint8Array ? { bytea: Buffer.from(value).toString('hex') } : value);
  return { entries: corpus.length, sha256: createHash('sha256').update(json).digest('hex'), json };
}
