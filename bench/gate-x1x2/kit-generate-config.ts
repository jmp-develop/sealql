import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './bench/gate-x1x2/kit-schema.ts',
  out: './bench/results/2026-09-27-gate-x1x2/kit-generated',
});
