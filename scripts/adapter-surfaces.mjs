export const adapterSurfaces = [{
  id: 'drizzle-v0.45',
  packageExport: './drizzle/v0.45',
  docs: 'docs/adapters/drizzle-v0.45.md',
  examples: 'examples/drizzle/v0.45',
  files: [
    'schema.ts',
    'app.ts',
    'managed-writes.ts',
    'search.ts',
    'raw-sql.ts',
    'integer-primary-key.ts',
    'model-key-tenant-scope.ts',
  ],
  smokeGroups: [
    ['schema.ts', 'managed-writes.ts', 'search.ts'],
    ['schema.ts', 'app.ts', 'raw-sql.ts', 'integer-primary-key.ts', 'model-key-tenant-scope.ts'],
  ],
}];

export const coreExamples = ['examples/core/sealer.ts'];
