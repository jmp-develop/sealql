/** X4 exploration (under lock): stream chunk size for count. Medians of 7 after 2 warm-ups. Not a reference measurement. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { combos } from '../verify-native/r8-cases.js';
import { OUT, json, median } from './x2-lib.js';
import { x4Count, lock, unlock, scopeA } from './x4-lib.js';
const ro = new pg.Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 4, options: '-c default_transaction_read_only=on' });
await assertDisposable(ro); assert.equal(Number((await ro.query('show port')).rows[0].port), 56439);
const out: any[] = [];
await lock('explore');
try {
  for (const name of ['and2', 'or2']) {
    const c = combos.find(x => x.name === name)!;
    for (const ch of [0, 512, 1024, 2048, 4096, 8192]) {
      const t: number[] = [], d: number[] = [];
      for (let i = 0; i < 9; i++) { const m = await x4Count(ro, c.node, ch > 0, scopeA, undefined, ch || 4096); if (i >= 2) { t.push(m.totalMs); d.push(m.dbMs); } }
      const r = { case: name, chunk: ch || 'batch', totalMs: +median(t).toFixed(1), dbMs: +median(d).toFixed(1) }; out.push(r); console.log(JSON.stringify(r));
    }
  }
  writeFileSync(`${OUT}/x4-explore.json`, json(out));
} finally { unlock(); await ro.end(); }
