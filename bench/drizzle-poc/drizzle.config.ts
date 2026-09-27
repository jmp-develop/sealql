import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect:'postgresql', schema:'./bench/drizzle-poc/schema.ts', out:'./bench/results/2026-09-27-drizzle-poc/kit' });
