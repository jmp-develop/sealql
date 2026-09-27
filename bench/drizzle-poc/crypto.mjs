import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, webcrypto } from 'node:crypto';

export async function probeCrypto() {
  const key = randomBytes(32), iv = randomBytes(12), aad = Buffer.from('scope:test'), plain = Buffer.from('example');
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]); const tag = cipher.getAuthTag();
  const dec = createDecipheriv('aes-256-gcm', key, iv); dec.setAAD(aad); dec.setAuthTag(tag);
  const roundtrip = Buffer.concat([dec.update(ct), dec.final()]).equals(plain);
  let wrongAadRejected = false;
  try { const bad = createDecipheriv('aes-256-gcm', key, iv); bad.setAAD(Buffer.from('wrong')); bad.setAuthTag(tag); bad.update(ct); bad.final(); }
  catch { wrongAadRejected = true; }
  const hmac = createHmac('sha384', key).update(plain).digest();
  const hkdf = Buffer.from(hkdfSync('sha384', key, iv, aad, 32));
  const n=100;
  const imported = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const hmacKey = await webcrypto.subtle.importKey('raw', key, {name:'HMAC',hash:'SHA-384'}, false, ['sign']);
  const hkdfKey = await webcrypto.subtle.importKey('raw', key, 'HKDF', false, ['deriveBits']);
  async function timed(fn) { const t=performance.now(); for(let i=0;i<n;i++) await fn(); return (performance.now()-t)/n; }
  const syncAesMs=await timed(() => {const c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(aad);c.update(plain);c.final();});
  const webAesMs=await timed(() => webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},imported,plain));
  const syncHmacMs=await timed(() => {createHmac('sha384',key).update(plain).digest();});
  const webHmacMs=await timed(() => webcrypto.subtle.sign('HMAC',hmacKey,plain));
  const syncHkdfMs=await timed(() => {hkdfSync('sha384',key,iv,aad,32);});
  const webHkdfMs=await timed(() => webcrypto.subtle.deriveBits({name:'HKDF',hash:'SHA-384',salt:iv,info:aad},hkdfKey,256));
  return { runtime: typeof process === 'object' ? process.version : 'workerd', roundtrip, wrongAadRejected, hmacBytes: hmac.length, hkdfBytes: hkdf.length, perCallMs:{syncAesMs,webAesMs,syncHmacMs,webHmacMs,syncHkdfMs,webHkdfMs}, timingNote:'100 sequential calls divided by 100; imported WebCrypto keys; local operation only, not production benchmark' };
}
