import { createSealer } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { pgTable, uuid } from 'drizzle-orm/pg-core';

export default { async fetch() {
  const sealer = createSealer({ key: new Uint8Array(32).fill(7) });
  const sealed = createSealed({ sealer });
  const workerRows = pgTable('worker_rows', { id: uuid('id').primaryKey(), title: sealed.text('title') });
  const workerIndex = sealed.register(workerRows, { row: 'id' });
  const context = { modelId: 'm', fieldId: 'title', keyScopeId: 'global', scopeId: 's', rowId: 'r', spec: { type: 'text' as const } };
  const ring = sealer.ring('m');
  const encrypted = await sealer.seal('Worker standard', context, ring);
  const opened = await sealer.open(encrypted, context, ring);
  return Response.json({ opened, encrypted: Array.from(encrypted), companion: !!workerIndex });
} };
