/** X1 debug: compare FastOpener AAD/key inputs with Sealer internals (no DB). */
import { createSealed as srcSealed } from '../../src/adapters/drizzle/v0.45/index.js';
import { registrationOf } from '../../src/adapters/drizzle/v0.45/native.js';
import { createSealer } from '../../src/core/field-cipher.js';
import { concat, frame, u32, hex } from '../../src/core/bytes.js';
import { codecId, codecParameters, codecVersion } from '../../src/core/field-codec.js';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
const KEY = new Uint8Array(32).fill(93); const sealer = createSealer({ key: KEY });
const sealed = srcSealed({ sealer }); const search = { exact: true, substring: { wordBoundary: true, skipGrams: true } } as const;
const t = pgSchema('x').table('customers', { id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), memo: sealed.text('memo', { search }) });
const reg = registrationOf(sealed.register(t as any, { row: 'id', scope: 'scopeId' }));
const b = reg.fields.get('memo')!; const spec = b.spec; console.log('spec', spec, 'model', reg.model);
const ks = sealer.keyScopeId(reg.model), fid = spec.id ?? 'memo', scope = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', row = '00000000-0000-4000-8000-000000000001';
const ctx = { modelId: reg.model, fieldId: fid, keyScopeId: ks, scopeId: scope, rowId: row, spec };
const fc = (sealer as any).fieldContext(ctx);
const theirs = (sealer as any).aad(fc, new TextEncoder().encode(scope), new TextEncoder().encode(row));
const stat = frame(['sealql/aad/v3', new Uint8Array([3]), reg.model, fid, codecId(spec), u32(codecVersion(spec)), codecParameters(spec), ks]);
const mine = concat(concat(u32(10), stat.subarray(4)), u32(36), new TextEncoder().encode(scope), u32(36), new TextEncoder().encode(row));
console.log('aad equal', hex(theirs) === hex(mine));
const ct = await sealer.seal('hello 서비스', ctx, sealer.ring(reg.model));
const m = await crypto.subtle.importKey('raw', KEY, 'HKDF', false, ['deriveKey']);
let h = 0x811c9dc5; for (let i = 0; i < 36; i++) h = Math.imul(h ^ row.charCodeAt(i), 0x01000193);
const k = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-384', salt: new Uint8Array(), info: frame(['sealql/cipher/v3', reg.model, fid, codecId(spec), u32(codecVersion(spec)), codecParameters(spec), ks, new Uint8Array([h & 0xff])]) }, m, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
console.log(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ct.subarray(1, 13), additionalData: mine, tagLength: 128 }, k, ct.subarray(13))));
// DB part (3 rows, read-only)
import pg from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const pool = new pg.Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1, options: '-c default_transaction_read_only=on' });
await assertDisposable(pool);
const BIN = { getTypeParser: (oid: number, fmt?: string) => fmt === 'binary' && oid === 17 ? (b: Buffer) => b : pg.types.getTypeParser(oid, fmt as any) };
for (const binary of [false, true]) {
  const r = (await pool.query({ text: `select id::text as id, memo_ct as memo from native_verify_main.customers where scope_id=$1 limit 2`, values: [scope], binary, types: BIN } as any)).rows;
  for (const x of r) {
    const c2 = { ...ctx, rowId: x.id };
    let out: string; try { out = String(await sealer.open(new Uint8Array(x.memo), c2, sealer.ring(reg.model))); } catch (e) { out = 'ERR ' + e; }
    console.log(binary, x.id, x.memo.length, x.memo[0], out.slice(0, 30));
  }
}
await pool.end();
