/** Load fixed root keys before constructing SealQL. */
import { createSealer } from 'sealql';

async function loadSecret(name: string): Promise<Uint8Array> {
  throw new Error(`Configure a secret loader for ${name}`);
}

export async function createConfiguredSealer() {
  const [key, sensitiveKey] = await Promise.all([
    loadSecret('sealql/global'), loadSecret('sealql/sensitiveNote'),
  ]);
  return createSealer({ key, models: { sensitiveNote: { key: sensitiveKey } } });
}
