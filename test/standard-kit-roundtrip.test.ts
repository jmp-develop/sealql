import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { assertDisposable } from './disposable.js';

test('package schema generates, migrates, and pushes twice without drift', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  const local = await realpath(resolve('.local'));
  const temporary = await mkdtemp(resolve(local, 'kit-roundtrip-'));
  assert.ok(temporary.startsWith(local + sep));
  let created = false;
  try {
    await assertDisposable(pool);
    assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
    assert.equal((await pool.query("select count(*)::int as n from pg_namespace where nspname in ('test_kit_roundtrip','test_kit_roundtrip_meta')")).rows[0].n, 0);
    created = true;
    const config = resolve(temporary, 'drizzle.config.ts').replaceAll('\\', '/');
    const out = resolve(temporary, 'out').replaceAll('\\', '/');
    await writeFile(config, `import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect: 'postgresql', schema: './test/standard-kit-schema.ts',
  out: ${JSON.stringify(out)}, schemaFilter: ['test_kit_roundtrip'],
  migrations: { schema: 'test_kit_roundtrip_meta' },
  dbCredentials: { url: 'postgresql://sealql_test@127.0.0.1:56439/postgres' } });\n`);
    const kit = (verb: string) => {
      const result = spawnSync(process.execPath, ['node_modules/drizzle-kit/bin.cjs', verb, ...(verb === 'push' ? ['--verbose'] : []), `--config=${config}`],
        { encoding: 'utf8', timeout: 60000 });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      assert.equal(result.status, 0, output);
      return output;
    };
    const generated = kit('generate');
    const migrated = kit('migrate');
    assert.match(generated, /tables?/i);
    assert.match(migrated, /migrations applied successfully/i);
    assert.match(kit('push'), /No changes detected/);
    assert.match(kit('push'), /No changes detected/);
  } finally {
    if (created) {
      await pool.query('drop schema if exists test_kit_roundtrip cascade');
      await pool.query('drop schema if exists test_kit_roundtrip_meta cascade');
    }
    await pool.end();
    await rm(temporary, { recursive: true, force: true });
  }
});
