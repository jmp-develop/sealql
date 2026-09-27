import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './bench/gate-x1x2/kit-push-schema.ts',
  out: './bench/results/2026-09-27-gate-x1x2/kit-generated',
  dbCredentials: { url: 'postgresql://sealql_test@127.0.0.1:56439/postgres' },
  schemaFilter: ['gate_x1x2_kit'],
  tablesFilter: ['plain'],
});
