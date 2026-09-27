import { createSealer } from '../src/index.js';

export default { async fetch() {
  const sealer = createSealer({ key: new Uint8Array(32).fill(7) });
  const context = { modelId: 'm', fieldId: 'title', keyScopeId: 'global', scopeId: 's', rowId: 'r', spec: { type: 'text' as const } };
  const ring = sealer.ring('m');
  const encrypted = await sealer.seal('Worker standard', context, ring);
  const opened = await sealer.open(encrypted, context, ring);
  return Response.json({ opened, encrypted: Array.from(encrypted) });
} };
