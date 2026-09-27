import { defineConfig } from 'drizzle-kit';
export default defineConfig({dialect:'postgresql',schema:'./bench/drizzle-poc/falsify-schema.ts',out:'./bench/results/2026-09-27-drizzle-falsify/kit-e5'});
