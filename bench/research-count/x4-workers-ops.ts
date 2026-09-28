/**
 * X4 Workers micro-benchmark ops (runtime-neutral; used inside workerd by x4-workers-entry.ts and in Node by x4-workers.ts).
 * Data: plaintexts derived in memory from fixture values (and2 certificate: company + memo of 21,176 rows = 42,352 fields).
 * Keys are fixed test bytes (benchmark only).
 */
import { macKey, prefix, cbcKeys, sealOne, openBatch, tagDiff, cbcRawDecrypt, type Job } from './x4-crypto.js';
import { frame, u32, concat } from '../../src/core/bytes.js';

const enc = new TextEncoder();
type State = { gcm: { k: CryptoKey; iv: Uint8Array; aad: Uint8Array; data: Uint8Array }[]; jobs: Job[]; cbc: Awaited<ReturnType<typeof cbcKeys>>; mk: ReturnType<typeof macKey> };
let st: State | null = null;
const params = enc.encode('{"exact":true,"substring":{"skipGrams":true,"wordBoundary":true}}');
const aadPrefix = (hdr: number, field: string, scope: string) => { const f = frame(['sealql/aad/v3', new Uint8Array([hdr]), 'customers', field, 'legacy-text', u32(2), params, 'global']);
  const s = new Uint8Array(1 + f.length); s[0] = hdr; s.set(f, 1); new DataView(s.buffer).setUint32(1, 10); const sb = enc.encode(scope); return concat(s, u32(sb.length), sb); };
export async function prepare(items: { row: string; field: string; value: string }[], scope: string) {
  // GCM like the product: 256 shard keys per field (only those used get derived), 96-bit IV, AAD incl. scope + rowId
  const gk = new Map<string, CryptoKey>();
  const gcmKey = async (field: string, s: number) => { const id = `${field}/${s}`; let k = gk.get(id); if (!k) { k = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt', 'decrypt']); gk.set(id, k); } return k; };
  const gcm: State['gcm'] = [];
  for (const it of items) {
    let h = 0x811c9dc5; for (let i = 0; i < it.row.length; i++) h = Math.imul(h ^ it.row.charCodeAt(i), 0x01000193);
    const k = await gcmKey(it.field, h & 0xff); const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = concat(aadPrefix(3, it.field, scope), u32(it.row.length), enc.encode(it.row));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, k, enc.encode(it.value)));
    gcm.push({ k, iv, aad, data });
  }
  const cbc = await cbcKeys(new Uint8Array(32).fill(1)); const mk = macKey(new Uint8Array(32).fill(2));
  const pre = new Map<string, ReturnType<typeof prefix>>(); const P = (f: string) => { let p = pre.get(f); if (!p) { p = prefix(mk, aadPrefix(5, f, scope)); pre.set(f, p); } return p; };
  const jobs: Job[] = [];
  for (const it of items) jobs.push({ env: await sealOne(cbc, mk, 5, P(it.field), it.row, enc.encode(it.value)), rowId: it.row, pre: P(it.field) });
  st = { gcm, jobs, cbc, mk };
  return { fields: items.length, gcmBytes: gcm.reduce((a, g) => a + g.data.length + 13, 0), x4Bytes: jobs.reduce((a, j) => a + j.env.length, 0), shardKeys: gk.size };
}
async function pool64<T>(xs: T[], f: (x: T) => Promise<unknown>) { let i = 0; await Promise.all(Array.from({ length: Math.min(64, xs.length) }, async () => { while (i < xs.length) await f(xs[i++]); })); }
export const ops: Record<string, () => Promise<number>> = {
  noop: async () => 0,
  gcmDecryptPool64: async () => { let n = 0; await pool64(st!.gcm, async g => { await crypto.subtle.decrypt({ name: 'AES-GCM', iv: g.iv, additionalData: g.aad, tagLength: 128 }, g.k, g.data); n++; }); return n; },
  gcmDecryptAll: async () => (await Promise.all(st!.gcm.map(g => crypto.subtle.decrypt({ name: 'AES-GCM', iv: g.iv, additionalData: g.aad, tagLength: 128 }, g.k, g.data)))).length,
  jsHmacVerify: async () => { let d = 0; for (const j of st!.jobs) { const e = j.env, to = e.length - 32; d |= tagDiff(st!.mk, j.pre, j.rowId, e, 1, to, to); } if (d) throw Error('tag'); return st!.jobs.length; },
  cbcBatchDecrypt: async () => { const js = st!.jobs; let total = 0; for (const j of js) total += j.env.length - 33; const cb = new Uint8Array(total + 32); let o = 0; for (const j of js) { cb.set(j.env.subarray(1, j.env.length - 32), o); o += j.env.length - 33; } await cbcRawDecrypt(st!.cbc, cb, total); return js.length; },
  x4OpenBatch: async () => (await openBatch(st!.cbc, st!.mk, 5, st!.jobs)).length,
};
