import assert from 'node:assert/strict';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { test } from 'node:test';
import { frame, u32, utf8 } from '../src/core/bytes.js';
import { profiles } from '../src/core/search-tokens.js';
import { exactBytes, positionProof, stamp, stampKey } from '../src/core/search-stamps.js';

test('stamp derivation and signed big endian digest match independent crypto', async () => {
  const ring = { keyScopeId: 'global', key: new Uint8Array(32).fill(7) };
  const profile = profiles('notes', 'body', { type: 'text', search: { substring: true } })[0];
  const info = frame(['sealql/search-stamp/v1', 'global', 'notes', 'body', 'text', u32(2), new Uint8Array(), 'legacy-text-v1', 'compact2']);
  const root = hkdfSync('sha384', ring.key, new Uint8Array(), info, 32);
  const expected = createHmac('sha256', Buffer.from(root)).update(frame(['scope', utf8('가나')])).digest();
  const key = await stampKey(ring, profile, 'compact2', 'scope', utf8('가나'));
  assert.deepEqual(key, new Uint8Array(expected));
  const salt = new Uint8Array(16).fill(9);
  const digest = createHash('sha256').update(Buffer.concat([expected, salt, u32(3)])).digest();
  assert.equal(await stamp(key, salt, 3), digest.readBigInt64BE());
  assert.equal(await stamp(key, salt), createHash('sha256').update(Buffer.concat([expected, salt])).digest().readBigInt64BE());
  assert.notDeepEqual(await stampKey(ring, profile, 'single1', 'scope', utf8('가나')), key);
  assert.notDeepEqual(await stampKey(ring, profile, 'compact2', 'other', utf8('가나')), key);
  assert.notDeepEqual(await stampKey({ ...ring, key: new Uint8Array(32).fill(8) }, profile, 'compact2', 'scope', utf8('가나')), key);
});

test('position proofs retain occurrences, stream domains, Unicode and empty values', async () => {
  const ring = { keyScopeId: 'global', key: new Uint8Array(32).fill(7) };
  const profile = profiles('notes', 'body', { type: 'text', search: { substring: { wordBoundary: true } } })[0];
  const value = 'Ａ가 Ａ가😀';
  const proof = await positionProof(ring, profile, 'scope', value, 'compact2');
  assert.equal(proof.length, 5);
  assert.deepEqual([...proof.offsets].sort((a, b) => a - b), [0, 1, 2, 3]);
  const key = await stampKey(ring, profile, 'compact2', 'scope', utf8('a가'));
  assert.equal(proof.offsets[proof.stamps.indexOf(await stamp(key, proof.salt, 1))], 0);
  assert.equal(proof.offsets[proof.stamps.indexOf(await stamp(key, proof.salt, 2))], 2);
  const words = await positionProof(ring, profile, 'scope', value, 'words2');
  assert.equal(words.length, 6);
  assert.notDeepEqual(words.salt, proof.salt);
  const single = await positionProof(ring, profile, 'scope', value, 'single1');
  assert.equal(single.stamps.length, 5);
  assert.equal((await positionProof(ring, profile, 'scope', '', 'compact2')).stamps.length, 0);
  assert.equal((await positionProof(ring, profile, 'scope', '😀', 'compact2')).length, 1);
  const decimal = profiles('notes', 'price', { type: 'decimal', precision: 8, scale: 2, search: { exact: true } })[0];
  assert.deepEqual(exactBytes(decimal, '+0001.0'), utf8('1.00'));
});
