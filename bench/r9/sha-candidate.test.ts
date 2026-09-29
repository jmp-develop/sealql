import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {u32} from '../../src/core/bytes.js';
import {stampHasher} from './sha-candidate.js';

test('batched single-block stamps equal independent SHA-256 for random inputs and all ordinal boundaries', () => {
  // NIST CAVP SHA256ShortMsg.rsp, Len=384 and Len=416 (byte-oriented vectors).
  // https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Algorithm-Validation-Program/documents/shs/shabytetestvectors.zip
  for (const [message,expected] of [
    ['4eef5107459bddf8f24fc7656fd4896da8711db50400c0164847f692b886ce8d7f4d67395090b3534efd7b0d298da34b','7c5d14ed83dab875'],
    ['77a879cfa11d7fcac7a8282cc38a43dcf37643cc909837213bd6fd95d956b219a1406cbe73c52cd56c600e55b75bc37ea69641bc','c99d64fa4dadd4bc'],
  ]) {
    const bytes=Buffer.from(message,'hex');
    assert.equal(stampHasher(bytes.subarray(0,32),bytes.subarray(32,48))(bytes.length===52?bytes.readUInt32BE(48):undefined),Buffer.from(expected,'hex').readBigInt64BE());
  }
  for (let sample=0;sample<256;sample++) {
    const key=crypto.getRandomValues(new Uint8Array(32)),salt=crypto.getRandomValues(new Uint8Array(16));
    const digest=stampHasher(key,salt);
    for (const ordinal of [undefined,1,255,256,65535,65536,0x7fffffff,0x80000000,0xffffffff,undefined]) {
      const expected=createHash('sha256').update(Buffer.concat([key,salt,...(ordinal===undefined?[]:[u32(ordinal)])])).digest().readBigInt64BE();
      assert.equal(digest(ordinal),expected);
    }
  }
  const digest=stampHasher(new Uint8Array(32),new Uint8Array(16));
  for (const ordinal of [0,-1,1.5,0x100000000]) assert.throws(()=>digest(ordinal),{code:'INVALID_VALUE'});
});
