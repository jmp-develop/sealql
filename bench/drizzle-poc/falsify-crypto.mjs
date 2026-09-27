import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, webcrypto } from 'node:crypto';

export async function probe() {
const n = 10000, fields = 6;
const key = new Uint8Array(32).fill(31), iv = new Uint8Array(12).fill(7), aad = Buffer.from('scope=A;model=M;field=F');
const plain = Buffer.from('known plaintext');
const c = createCipheriv('aes-256-gcm',key,iv); c.setAAD(aad);
const ciphertext = Buffer.concat([c.update(plain),c.final(),c.getAuthTag()]);
const wcKey = await webcrypto.subtle.importKey('raw',key,'AES-GCM',false,['encrypt','decrypt']);
const wcCipher = Buffer.from(await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},wcKey,plain));
const syncHmac = createHmac('sha384',key).update(plain).digest();
const whKey = await webcrypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-384'},false,['sign']);
const webHmac = Buffer.from(await webcrypto.subtle.sign('HMAC',whKey,plain));
const syncHkdf = Buffer.from(hkdfSync('sha384',key,iv,aad,32));
const wkKey = await webcrypto.subtle.importKey('raw',key,'HKDF',false,['deriveBits']);
const webHkdf = Buffer.from(await webcrypto.subtle.deriveBits({name:'HKDF',hash:'SHA-384',salt:iv,info:aad},wkKey,256));
const cpu0=typeof process==='object' && typeof process.cpuUsage==='function'?process.cpuUsage():undefined;
const t=performance.now();let bytes=0;
for(let i=0;i<n*fields;i++) { const d=createDecipheriv('aes-256-gcm',key,iv);d.setAAD(aad);d.setAuthTag(ciphertext.subarray(-16));bytes+=d.update(ciphertext.subarray(0,-16)).length+d.final().length; }
const decryptCpuMs=performance.now()-t;
const cpu=cpu0&&typeof process==='object'?process.cpuUsage(cpu0):undefined;
function seal(rowBound,rowId){const a=Buffer.from(`scope=A;field=F${rowBound?`;row=${rowId}`:''}`);const nonce=randomBytes(12);const e=createCipheriv('aes-256-gcm',key,nonce);e.setAAD(a);return {nonce, ct:Buffer.concat([e.update(plain),e.final()]),tag:e.getAuthTag()};}
function open(record,rowBound,rowId){try{const a=Buffer.from(`scope=A;field=F${rowBound?`;row=${rowId}`:''}`);const d=createDecipheriv('aes-256-gcm',key,record.nonce);d.setAAD(a);d.setAuthTag(record.tag);return Buffer.concat([d.update(record.ct),d.final()]).toString();}catch{return 'AUTH_FAIL';}}
const noRow=seal(false,1), bound=seal(true,1);
const tokenFor=()=>createHmac('sha384',key).update(plain).digest('hex').slice(0,4);
return {e1:{aesEqual:ciphertext.equals(wcCipher),hmacEqual:syncHmac.equals(webHmac),hkdfEqual:syncHkdf.equals(webHkdf),decryptCalls:n*fields,decryptWallMs:decryptCpuMs,processCpuMs:cpu?(cpu.user+cpu.system)/1000:null,bytes},e7:{sameScopeMoved:open(noRow,false,2),rowBoundMoved:open(bound,true,2),sameScopeOriginal:open(noRow,false,1),rowBoundOriginal:open(bound,true,1),snapshotTokensEqual:tokenFor()===tokenFor(),cipherLengthsEqual:noRow.ct.length===bound.ct.length}};
}
