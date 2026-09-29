import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { registrationOf } from '../src/adapters/drizzle/v0.45/native.js';
import { boundedCandidatePredicate, candidatePredicate, candidateRows } from '../src/core/candidate-sql.js';
import { compileSearch } from '../src/core/search-predicate.js';
import { profiles } from '../src/core/search-tokens.js';
import { keyArray, patternProgram } from '../src/core/stamp-query.js';
import type { Node } from '../src/core/sql-fragment.js';

const parameters = (node: Node): unknown[] => node.kind === 'param' ? [node.value]
  : node.kind === 'concat' ? node.nodes.flatMap(parameters) : [];

test('candidate token selection preserves all proof inputs across companion, parent and bounded paths', async () => {
  const cipher = createSealer({ key: new Uint8Array(32).fill(72) }), sealed = createSealed({ sealer: cipher });
  const table = pgSchema('test_candidate_compile').table('rows', {
    id: uuid('id').primaryKey(), body: sealed.text('body', { search: { exact: true, substring: true } }),
  });
  const reg = registrationOf(sealed.register(table, { row: 'id' }));
  const stored = profiles(reg.model, 'body', reg.definition.fields.body), ring = cipher.ring(reg.model);
  for (const op of ['contains', 'startsWith', 'endsWith', 'like', 'eq'] as const) {
    const search = await compileSearch({ field: 'body', op, value: op === 'like' ? '%abcdefgh%ijklmnop%' : 'abcdefghijklmnop' }, reg.definition, stored, ring, 's');
    assert.equal(search.op, 'leaf'); if (search.op !== 'leaf') throw Error('expected leaf');
    const original = structuredClone(search), { proof } = search.leaf;
    if (op !== 'eq') assert.ok(search.leaf.tokens.length > 3);
    // Fixed signed-token examples exercise the odd/even middle and the unchanged short cases.
    const examples = op === 'eq' ? [[search.leaf.tokens, search.leaf.tokens]] : [
      [['-99'], ['-99']], [['-99', '100'], ['-99', '100']], [['-99', '0', '100'], ['-99', '0', '100']],
      [['-99', '-12', '8', '100'], ['-99', '-12', '100']],
      [['-99', '-12', '0', '8', '100'], ['-99', '0', '100']],
      [['-99', '-12', '0', '4', '8', '100'], ['-99', '0', '100']],
    ];
    for (const [tokens, expected] of examples) {
      const input = { ...search, leaf: { ...search.leaf, tokens } };
      const fragments = [candidateRows(reg.storage, 's', input), candidatePredicate(reg.definition, reg.storage, 's', input),
        boundedCandidatePredicate(reg.definition, reg.storage, 's', input, 301, 'after')];
      for (const fragment of fragments) {
        const params = parameters(fragment.node);
        const candidateArrays = params.filter(value => Array.isArray(value) && typeof value[0] === 'string');
        if (op === 'eq') {
          assert.deepEqual(candidateArrays, []);
          assert.ok(params.includes(tokens[0]));
          assert.ok(params.some(value => value instanceof Uint8Array && Buffer.from(value).equals(Buffer.from(proof.keys[0]))));
        } else {
          assert.ok(candidateArrays.length > 0);
          for (const value of candidateArrays) assert.deepEqual(value, expected);
          assert.ok(params.includes(keyArray(proof.keys)), 'all stamp keys still reach the DB');
          const program = proof.pattern ? patternProgram(proof.pattern) : proof.offsets;
          assert.ok(params.some(value => Array.isArray(value) && JSON.stringify(value) === JSON.stringify(program)), 'full position/LIKE program remains');
          if (!proof.pattern) { assert.ok(params.includes(proof.length)); assert.ok(params.includes(proof.affix ?? 0)); }
        }
      }
    }
    assert.deepEqual(search, original, 'query compilation does not mutate the full token or proof arrays');
  }
});
