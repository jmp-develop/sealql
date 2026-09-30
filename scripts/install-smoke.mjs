import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { adapterSurfaces, coreExamples } from './adapter-surfaces.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const consumer = path.join(root, '.local', 'consumer');
if (!process.env.npm_execpath) throw new Error('Run through npm run test:install');
const npm = args => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, stdio: 'inherit' });

function compileInstalled(files) {
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, skipLibCheck: false, noEmit: true };
  const program = ts.createProgram(files.map(name => path.join(consumer, name)), options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const actionable = diagnostics.filter(d => {
    const file = d.file?.fileName.replaceAll('\\', '/') ?? '';
    return !file.includes('/node_modules/drizzle-orm/') && !file.includes('/node_modules/drizzle-kit/');
  });
  if (actionable.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(actionable, {
    getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  if (diagnostics.length) console.log(`Ignored ${diagnostics.length} upstream Drizzle declaration diagnostics`);
}

async function copyExample(relative) {
  const target = path.join(consumer, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, relative), target);
}

await mkdir(consumer, { recursive: true });
await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
for (const file of coreExamples) await copyExample(file);
for (const surface of adapterSurfaces) {
  for (const file of surface.files) await copyExample(`${surface.examples}/${file}`);
}

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
npm(['pack', '--pack-destination', '.local', '--quiet']);
npm(['install', '--prefix', consumer, '--ignore-scripts', '--no-audit', '--no-fund',
  path.join(root, '.local', `${pkg.name}-${pkg.version}.tgz`), 'drizzle-orm@0.45.3', 'drizzle-kit@0.31.11', 'pg@8.23.0', '@types/pg@8.15.0']);

compileInstalled(coreExamples);
for (const surface of adapterSurfaces) {
  for (const group of surface.smokeGroups) compileInstalled(group.map(file => `${surface.examples}/${file}`));
  for (const required of [surface.docs, surface.examples]) {
    if (!existsSync(path.join(consumer, 'node_modules', pkg.name, required))) throw new Error(`Packed surface missing: ${required}`);
  }
}

const imports = [`import * as core from '${pkg.name}';`,
  ...adapterSurfaces.map((surface, index) => `import * as adapter${index} from '${pkg.name}/${surface.packageExport.slice(2)}';`),
  `if (!core.createSealer${adapterSurfaces.map((_, index) => ` || !adapter${index}.createSealed`).join('')}) throw new Error('Missing package export');`,
].join('\n');
await writeFile(path.join(consumer, 'smoke.mjs'), `${imports}\n`);
execFileSync(process.execPath, [path.join(consumer, 'smoke.mjs')], { cwd: consumer, stdio: 'inherit' });

const adapter = adapterSurfaces[0];
await writeFile(path.join(consumer, 'kit-schema.ts'), `import { pgTable, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from '${pkg.name}';
import { createSealed } from '${pkg.name}/${adapter.packageExport.slice(2)}';
const sealed = createSealed({ sealer: () => createSealer({ key: new Uint8Array(32) }) });
export const note = pgTable('kit_smoke_note', { id: uuid('id').primaryKey(), title: sealed.text('title', { search: { exact: true } }) });
export const noteSeal = sealed.register(note, { row: 'id' });
`);
await writeFile(path.join(consumer, 'kit.config.ts'), `import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect: 'postgresql', schema: './kit-schema.ts', out: './kit-generated' });
`);
execFileSync(process.execPath, [path.join(consumer, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'generate', '--config=kit.config.ts'],
  { cwd: consumer, stdio: 'inherit' });
const kitFiles = await readdir(path.join(consumer, 'kit-generated'));
if (!kitFiles.some(name => name.endsWith('.sql'))) throw new Error('drizzle-kit did not generate SQL from package-name imports');
console.log('Installed adapter examples compile with drizzle-orm 0.45.3');

npm(['install', '--prefix', consumer, '--ignore-scripts', '--no-audit', '--no-fund', 'drizzle-orm@0.45.2']);
compileInstalled(coreExamples);
for (const surface of adapterSurfaces) {
  for (const group of surface.smokeGroups) compileInstalled(group.map(file => `${surface.examples}/${file}`));
}
console.log('Installed adapter examples compile with drizzle-orm 0.45.2');
