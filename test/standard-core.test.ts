import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSealer, exactBitsForPopulation, normalizeText, normalizeWords, profiles, searchPieces, searchTokens } from '../src/index.js';
import { canonical, frame, hex, u32, utf8 } from '../src/core/bytes.js';
import { codecId, codecParameters, codecVersion, decodeField, encodeField } from '../src/core/field-codec.js';
import { openCursor, sealCursor } from '../src/core/search-cursor.js';
import { validateSearch, type SearchNode } from '../src/core/search-predicate.js';
import type { SearchTokenCache } from '../src/core/search-tokens.js';

const root = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const spec = { type: 'text', search: { exact: { bits: 32 }, substring: { wordBoundary: true, skipGrams: true } } } as const;
const context = (rowId: string, fieldId = 'body') => ({ modelId: 'note', fieldId, keyScopeId: 'global', scopeId: 'tenant', rowId, spec });

test('large JSON and deep nesting have no library size or depth cap', () => {
  const many = Array.from({ length: 10001 }, (_, index) => index);
  assert.deepEqual(decodeField({ type: 'json' }, encodeField({ type: 'json' }, many)), many);
  let deep: any = null;
  for (let i = 0; i < 1000; i++) deep = [deep];
  const encoded = encodeField({ type: 'json' }, deep);
  let decoded: any = decodeField({ type: 'json' }, encoded);
  for (let i = 0; i < 1000; i++) decoded = decoded[0];
  assert.equal(decoded, null);
  assert.deepEqual(canonical({ nested: [1, 'x', null], empty: {} }), frame(['object',
    frame(['empty', frame(['object'])]),
    frame(['nested', frame(['array', frame(['num', new Uint8Array([63, 240, 0, 0, 0, 0, 0, 0])]), frame(['str', 'x']), frame(['null'])])]),
  ]));
  assert.ok(canonical({ deep }).length > 0);
});

test('search expression accepts more than eight leaves and nested groups', () => {
  const leaf: SearchNode = { op: 'eq', field: 'body', value: 'sample' };
  const many: SearchNode = { op: 'all', children: Array.from({ length: 20 }, () => leaf) };
  let deep: SearchNode = many;
  for (let i = 0; i < 20; i++) deep = { op: 'any', children: [deep] };
  validateSearch(deep, { fields: { body: { type: 'text', search: { exact: true } } } } as any);
});

test('normalization folds NFC, full-width ASCII, and ASCII case', () => {
  assert.equal(normalizeText('한ＡＢ１２', 'legacy-text-v1'), '한ab12');
  assert.equal(normalizeText('한ab12', 'legacy-text-v1'), '한ab12');
  assert.equal(normalizeWords('  ＡＢ  CＤ  '), 'ab cd');
});

test('ciphertext binds row and field, rejects tampering, and uses multiple shards', async () => {
  const sealer = createSealer({ key: root });
  const ring = sealer.ring('note');
  const encrypted = await sealer.seal('hello', context('r1'), ring);
  assert.equal(await sealer.open(encrypted, context('r1'), ring), 'hello');
  await assert.rejects(sealer.open(encrypted, context('r2'), ring), { code: 'AUTHENTICATION_FAILED' });
  await assert.rejects(sealer.open(encrypted, { ...context('r1'), scopeId: 'other-tenant' }, ring), { code: 'AUTHENTICATION_FAILED' });
  await assert.rejects(sealer.open(encrypted, context('r1', 'other'), ring), { code: 'AUTHENTICATION_FAILED' });
  const corrupt = encrypted.slice(); corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(sealer.open(corrupt, context('r1'), ring), { code: 'AUTHENTICATION_FAILED' });
  const shards = new Set(Array.from({ length: 128 }, (_, i) => (sealer as any).shard(utf8(`row-${i}`))));
  assert.ok(shards.size > 80);
  assert.equal(encrypted.length, 5 + 29);
});

test('cached field context preserves versionless AAD bytes and opens independent ciphertext', async () => {
  const sealer = createSealer({ key: root });
  const ring = sealer.ring('note');
  for (const c of [context('row-한글'), { ...context('row-한글', 'price'), spec: { type: 'decimal', precision: 12, scale: 2 } as const }]) {
    const header = new Uint8Array([3]);
    const expectedAad = frame(['sealql/aad/v3', header, c.modelId, c.fieldId, codecId(c.spec), u32(codecVersion(c.spec)), codecParameters(c.spec), c.keyScopeId, c.scopeId, c.rowId]);
    const prepared = (sealer as any).fieldContext(c);
    assert.deepEqual((sealer as any).aad(prepared, utf8(c.scopeId), utf8(c.rowId)), expectedAad);
    const shard = (sealer as any).shard(utf8(c.rowId));
    const material = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveKey']);
    const info = frame(['sealql/cipher/v3', c.modelId, c.fieldId, codecId(c.spec), u32(codecVersion(c.spec)), codecParameters(c.spec), c.keyScopeId, new Uint8Array([shard])]);
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-384', salt: new Uint8Array(), info: info as Uint8Array<ArrayBuffer> }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const value = c.spec.type === 'text' ? 'legacy 한글' : '123.45';
    const nonce = new Uint8Array(12).fill(7);
    const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: expectedAad as Uint8Array<ArrayBuffer>, tagLength: 128 }, key, utf8(value) as Uint8Array<ArrayBuffer>));
    const independentEnvelope = new Uint8Array(header.length + nonce.length + body.length);
    independentEnvelope.set(header); independentEnvelope.set(nonce, header.length); independentEnvelope.set(body, header.length + nonce.length);
    assert.equal(await sealer.open(independentEnvelope, c, ring), value);
    const currentEnvelope = await sealer.seal(value, c, ring);
    assert.equal(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: currentEnvelope.subarray(1, 13) as Uint8Array<ArrayBuffer>, additionalData: expectedAad as Uint8Array<ArrayBuffer>, tagLength: 128 }, key, currentEnvelope.subarray(13) as Uint8Array<ArrayBuffer>)), value);
  }
});

test('cursor key cache keeps independent root keys isolated', async () => {
  const context = { modelId: 'note', scopeId: 'tenant', keyScopeId: 'global', queryDigest: 'same-query' };
  const first = { keyScopeId: 'global', key: root };
  const second = { keyScopeId: 'global', key: new Uint8Array(32).fill(9) };
  const cursor = await sealCursor(context, { lastId: 'row-1' }, first);
  assert.deepEqual(await openCursor(cursor, context, first), { lastId: 'row-1', lastSort: undefined });
  await assert.rejects(openCursor(cursor, { ...context, scopeId: 'other-tenant' }, first), { code: 'CURSOR_INVALID' });
  await assert.rejects(openCursor(cursor, context, second), { code: 'CURSOR_INVALID' });
  const other = await sealCursor(context, { lastId: 'row-2' }, second);
  assert.deepEqual(await openCursor(other, context, second), { lastId: 'row-2', lastSort: undefined });
});

test('fixed global and model keys are copied at construction', async () => {
  const suppliedGlobal = root.slice(), suppliedModel = new Uint8Array(32).fill(11);
  const sealer = createSealer({ key: suppliedGlobal, models: { note: { key: suppliedModel } } });
  suppliedGlobal.fill(0); suppliedModel.fill(0);
  assert.equal(sealer.keyScopeId('note'), 'model:note');
  assert.equal(sealer.keyScopeId('other'), 'global');
  const modelContext = { ...context('r1'), keyScopeId: 'model:note' };
  const encrypted = await sealer.seal('model value', modelContext, sealer.ring('note'));
  assert.equal(await sealer.open(encrypted, modelContext, sealer.ring('note')), 'model value');
  await assert.rejects(sealer.open(encrypted, modelContext, sealer.ring('other')), { code: 'KEY_SCOPE_MISMATCH' });
});

test('field and token profile keys are shared across tenants without retaining scope prefixes', async () => {
  const sealer = createSealer({ key: root });
  const ring = sealer.ring('note');
  const p = profiles('note', 'body', spec)[1];
  const pieces = searchPieces(p, 'hello');
  const cache: SearchTokenCache = { profiles: new Map() };
  let firstToken: string[] = [];
  for (let i = 0; i < 32; i++) {
    const scopeId = `tenant-${i}`;
    const ciphertext = await sealer.seal('hello', { ...context('same-row'), scopeId }, ring);
    assert.equal(await sealer.open(ciphertext, { ...context('same-row'), scopeId }, ring), 'hello');
    const tokens = await searchTokens(ring, scopeId, p, pieces, cache);
    if (i === 0) firstToken = tokens;
    else assert.notDeepEqual(tokens, firstToken);
  }
  assert.equal((sealer as any).derived.size, 1);
  assert.equal(cache.profiles.size, 1);
  assert.deepEqual(await searchTokens(ring, 'tenant-0', p, pieces, cache), firstToken);
});

test('marked pieces are distinct from literal punctuation', async () => {
  const p = profiles('note', 'body', spec)[1];
  const pieces = searchPieces(p, 'a^b');
  const literal = searchPieces(p, '^<');
  const starts = searchPieces(p, 'a^', 'startsWith');
  assert.ok(pieces.length > 2);
  assert.ok(!pieces.some(bytes => hex(bytes) === hex(new TextEncoder().encode('^'))));
  assert.ok(starts.some(bytes => pieces.some(other => hex(bytes) === hex(other))));
  assert.ok(!literal.some(bytes => hex(bytes) === hex(searchPieces(p, 'a^', 'startsWith').at(-1)!)));
});

test('substring skip grams default on and only explicit false disables them', () => {
  const profileFor = (substring: true | { wordBoundary?: boolean; skipGrams?: boolean }) =>
    profiles('note', 'body', { type: 'text', search: { substring } })[0];
  const trueProfile = profileFor(true);
  const emptyProfile = profileFor({});
  const wordProfile = profileFor({ wordBoundary: true });
  const offProfile = profileFor({ skipGrams: false });
  const skipped = hex(frame(['skip', utf8('ac')]));
  for (const profile of [trueProfile, emptyProfile, wordProfile]) {
    assert.equal(profile.skipGrams, true);
    assert.ok(searchPieces(profile, 'abc').map(hex).includes(skipped));
    const stored = new Set(searchPieces(profile, 'xabcx').map(hex));
    assert.ok(searchPieces(profile, 'abc', 'contains').every(piece => stored.has(hex(piece))));
  }
  assert.equal(offProfile.skipGrams, false);
  assert.ok(!searchPieces(offProfile, 'abc').map(hex).includes(skipped));
});

test('word-respecting search uses only internal boundaries', () => {
  const p = profiles('note', 'body', spec)[1];
  const stored = new Set(searchPieces(p, '서세종대로 25번지').map(hex));
  const query = searchPieces(p, '세종대로 25', 'contains', true).map(hex);
  assert.ok(query.every(piece => stored.has(piece)), 'matching phrase inside edge words must remain a candidate');
});

test('exact bits allow 32 while substring tokens remain 16', async () => {
  assert.equal(exactBitsForPopulation(2 ** 21), 20);
  const sealer = createSealer({ key: root });
  const ring = sealer.ring('note');
  const [exact, substring] = profiles('note', 'body', spec);
  assert.equal(exact.bits, 32); assert.equal(substring.bits, 16);
  assert.equal((await searchTokens(ring, 'tenant', exact, searchPieces(exact, 'hello'))).length, 1);
});
