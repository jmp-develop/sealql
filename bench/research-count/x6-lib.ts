/** X6 shared: schema name + measure.lock (same protocol as X4, name prefix X6). Research only. */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
export const SCHEMA6 = 'research_count_x6';
const LOCK = '.local/research/measure.lock';
export async function lock(name: string) {
  for (;;) {
    if (!existsSync(LOCK)) { try { writeFileSync(LOCK, `X6 ${name} ${new Date().toISOString()}\n`, { flag: 'wx' }); return; } catch { /* raced */ } }
    console.error(`measure.lock held: ${existsSync(LOCK) ? readFileSync(LOCK, 'utf8').trim() : '?'}; waiting`);
    await new Promise(r => setTimeout(r, 60_000));
  }
}
export function unlock() { if (existsSync(LOCK) && readFileSync(LOCK, 'utf8').startsWith('X6 ')) unlinkSync(LOCK); }
