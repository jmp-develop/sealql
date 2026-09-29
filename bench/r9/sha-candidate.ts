import { ensure } from '../../src/core/errors.js';

// SHA-256's fixed round constants. Stamp messages are exactly 48 or 52 bytes,
// so padding always fits one block; no general-purpose hash API is exposed.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotate = (word: number, bits: number) => (word >>> bits) | (word << (32-bits));

/** Request-local workspace reused for one piece's ordinals; nothing is cached globally. */
export function stampHasher(key: Uint8Array, salt: Uint8Array): (ordinal?: number) => bigint {
  ensure(key.length === 32 && salt.length === 16, 'INVALID_VALUE');
  const words = new Uint32Array(64);
  const k = new DataView(key.buffer, key.byteOffset, key.byteLength), s = new DataView(salt.buffer, salt.byteOffset, salt.byteLength);
  for (let i=0;i<8;i++) words[i]=k.getUint32(i*4);
  for (let i=0;i<4;i++) words[i+8]=s.getUint32(i*4);
  return ordinal => {
    if (ordinal !== undefined) ensure(Number.isInteger(ordinal) && ordinal > 0 && ordinal <= 0xffffffff, 'INVALID_VALUE');
    words[12]=ordinal ?? 0x80000000; words[13]=ordinal === undefined ? 0 : 0x80000000;
    words[14]=0; words[15]=ordinal === undefined ? 384 : 416;
    for (let i=16;i<64;i++) {
      const x=words[i-15], y=words[i-2];
      words[i]=words[i-16]+(rotate(x,7)^rotate(x,18)^(x>>>3))+words[i-7]+(rotate(y,17)^rotate(y,19)^(y>>>10));
    }
    let a=0x6a09e667,b=0xbb67ae85,c=0x3c6ef372,d=0xa54ff53a,e=0x510e527f,f=0x9b05688c,g=0x1f83d9ab,h=0x5be0cd19;
    for (let i=0;i<64;i++) {
      const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+K[i]+words[i])|0;
      const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))|0;
      h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    return BigInt.asIntN(64,(BigInt((a+0x6a09e667)>>>0)<<32n)|BigInt((b+0xbb67ae85)>>>0));
  };
}
