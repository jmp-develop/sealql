import { TEXT_OPTS, trunc60 } from './lib.mjs';
export const EQF = ['company', 'phone', 'name', 'email'], SUBF = ['memo', 'address'];
export async function getKeys2(ce, plain) {
  const kv = plain.db('encryption').collection('__keyVault'); const out = {};
  for (const f of [...EQF, ...SUBF]) { const n = 'm2_' + f; const k = await kv.findOne({ keyAltNames: n }); out[f] = k ? k._id : await ce.createDataKey('local', { keyAltNames: [n] }); }
  return out;
}
export const fields2 = keys => ({ fields: [
  ...EQF.map(path => ({ path, bsonType: 'string', keyId: keys[path], queries: { queryType: 'equality', contention: 8 } })),
  ...SUBF.map(path => ({ path, bsonType: 'string', keyId: keys[path], queries: { queryType: 'substringPreview', strMaxLength: 60, strMinQueryLength: 2, strMaxQueryLength: 10, caseSensitive: true, diacriticSensitive: true, contention: 8 } })),
] });
export const row2doc = (r, i) => ({ _id: i + 1, id: r.id, company: r.company_norm, phone: r.phone_norm, name: r.name_norm, email: r.email_norm, memo: trunc60(r.memo_norm ?? ''), address: trunc60(r.address_norm ?? '') });
export async function encDoc2(ce, keys, d) {
  const o = { ...d };
  for (const f of EQF) o[f] = await ce.encrypt(d[f], { keyId: keys[f], algorithm: 'Indexed', contentionFactor: 8 });
  for (const f of SUBF) o[f] = await ce.encrypt(d[f], { keyId: keys[f], algorithm: 'String', contentionFactor: 8, stringOptions: TEXT_OPTS });
  return o;
}
export const encEq2 = (ce, keys, f, v) => ce.encrypt(v, { keyId: keys[f], algorithm: 'Indexed', queryType: 'equality', contentionFactor: 8 });
export const encSub2 = (ce, keys, f, v) => ce.encrypt(v, { keyId: keys[f], algorithm: 'String', queryType: 'substring', contentionFactor: 8, stringOptions: TEXT_OPTS });
