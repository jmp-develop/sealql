import assert from 'node:assert/strict';
import { test } from 'node:test';
import { standardSqlCorpus } from './standard-sql-corpus.js';

test('ordinary SQL, parameters, DDL, migrations and descriptors match the pre-hardened bytes', async () => {
  const result = await standardSqlCorpus();
  assert.equal(result.entries, 86);
  assert.equal(result.sha256, '9c176c3c59577b8a8354e195b388fcc8b0d3b419ddbb86faad612fb29375a935');
});
