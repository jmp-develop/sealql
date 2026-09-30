import { createSealer, type CipherContext } from 'sealql';

export async function roundTrip(rootKey: Uint8Array, value: string) {
  const sealer = createSealer({ key: rootKey });
  const context: CipherContext = {
    modelId: 'note', fieldId: 'body', keyScopeId: sealer.keyScopeId('note'),
    scopeId: 'tenant-id', rowId: 'row-id', spec: { type: 'text' },
  };
  const ciphertext = await sealer.seal(value, context, sealer.ring('note'));
  return sealer.open(ciphertext, context, sealer.ring('note'));
}

// Load rootKey once from secret storage. Core seal/open does not provide database search.
