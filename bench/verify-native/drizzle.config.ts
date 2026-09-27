import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql', schema: './bench/verify-native/schema.ts',
  out: './.local/native-verify-migrations', schemaFilter: ['native_verify_main'],
  migrations: { schema: 'native_verify_meta' },
  dbCredentials: { url: 'postgresql://sealql_test@127.0.0.1:56439/postgres' },
});
