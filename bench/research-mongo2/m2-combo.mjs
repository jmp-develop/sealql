// Checks whether the server accepts prefixPreview/suffixPreview combined with substringPreview on one field.
import fs from 'fs';
import { connect } from './lib.mjs';
import { getKeys2 } from './m2-lib.mjs';
const { plain, enc, ce } = await connect(); const keys = await getKeys2(ce, plain);
const S = { strMinQueryLength: 2, strMaxQueryLength: 10, caseSensitive: true, diacriticSensitive: true, contention: 8 };
const tries = {
  'substring+prefix+suffix': [{ queryType: 'substringPreview', strMaxLength: 60, ...S }, { queryType: 'prefixPreview', ...S }, { queryType: 'suffixPreview', ...S }],
  'substring+prefix': [{ queryType: 'substringPreview', strMaxLength: 60, ...S }, { queryType: 'prefixPreview', ...S }],
  'prefix+suffix': [{ queryType: 'prefixPreview', ...S }, { queryType: 'suffixPreview', ...S }],
};
const out = {};
for (const [k, q] of Object.entries(tries)) {
  const ef = { fields: [{ path: 'memo', bsonType: 'string', keyId: keys.memo, queries: q }] };
  try { await enc.db('mongo2').createCollection('combo_test', { encryptedFields: ef }); out[k] = 'accepted'; }
  catch (e) { out[k] = 'rejected: ' + e.message; }
  await enc.db('mongo2').dropCollection('combo_test', { encryptedFields: ef }).catch(() => {});
}
console.log(JSON.stringify(out, null, 1)); fs.writeFileSync('out/m2-combo.json', JSON.stringify(out, null, 1));
await plain.close(); await enc.close();
