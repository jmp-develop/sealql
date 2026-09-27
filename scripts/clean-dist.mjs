import { existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = resolve(root, 'dist');
if (dirname(target) !== root) throw new Error('Unexpected build output path');
if (existsSync(target)) {
  if (lstatSync(target).isSymbolicLink()) throw new Error('Refusing to remove symlinked build output');
  rmSync(target, { recursive: true });
}
