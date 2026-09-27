import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const root=fileURLToPath(new URL('..',import.meta.url));
const consumer=path.join(root,'.local','consumer');
if(!process.env.npm_execpath)throw new Error('Run through npm run test:install');
const npm=(args)=>execFileSync(process.execPath,[process.env.npm_execpath,...args],{cwd:root,stdio:'inherit'});
function compileInstalled(files) {
  const options={ target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, skipLibCheck: false, noEmit: true };
  const program=ts.createProgram(files.map(name=>path.join(consumer,name)),options);
  const diagnostics=ts.getPreEmitDiagnostics(program);
  // drizzle-orm 0.45 declarations reference optional drivers and have independent declaration errors.
  // Keep checking the installed SealQL declarations and consumer files with skipLibCheck disabled.
  const actionable=diagnostics.filter(d=>!d.file?.fileName.replaceAll('\\','/').includes('/node_modules/drizzle-orm/'));
  if(actionable.length)throw new Error(ts.formatDiagnosticsWithColorAndContext(actionable,{
    getCanonicalFileName:f=>f,getCurrentDirectory:()=>root,getNewLine:()=> '\n',
  }));
  if(diagnostics.length)console.log(`Ignored ${diagnostics.length} upstream drizzle-orm declaration diagnostics`);
}
await mkdir(consumer,{recursive:true});
await writeFile(path.join(consumer,'package.json'), JSON.stringify({ private: true, type: 'module' }));
await copyFile(path.join(root,'examples','standard-consumer.ts'),path.join(consumer,'standard-consumer.ts'));
for(const name of ['standard-raw.ts','standard-operations.ts','key-loader.ts'])await copyFile(path.join(root,'examples',name),path.join(consumer,name));
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
npm(['pack','--pack-destination','.local','--quiet']);
npm(['install','--prefix',consumer,'--ignore-scripts','--no-audit','--no-fund',path.join(root,'.local',`${pkg.name}-${pkg.version}.tgz`),'drizzle-orm@0.45.3','drizzle-kit@0.31.11','pg@8.23.0']);
compileInstalled(['standard-consumer.ts']);
compileInstalled(['standard-raw.ts','standard-operations.ts','key-loader.ts']);
await writeFile(path.join(consumer,'smoke.mjs'), "import * as core from 'sealql'; import * as drizzle from 'sealql/drizzle/v0.45'; if (!core.createSealer || !drizzle.createSealed) throw new Error('Missing package export');\n");
execFileSync(process.execPath,[path.join(consumer,'smoke.mjs')],{cwd:consumer,stdio:'inherit'});
await writeFile(path.join(consumer,'kit-schema.ts'), "import { pgTable, uuid } from 'drizzle-orm/pg-core';\nimport { createSealer } from 'sealql';\nimport { createSealed } from 'sealql/drizzle/v0.45';\nconst sealed = createSealed({ sealer: () => createSealer({ key: new Uint8Array(32) }) });\nexport const note = pgTable('kit_smoke_note', { id: uuid('id').primaryKey(), title: sealed.text('title', { search: { exact: true } }) });\nexport const noteSeal = sealed.register(note, { row: 'id' });\n");
await writeFile(path.join(consumer,'kit.config.ts'), "import { defineConfig } from 'drizzle-kit';\nexport default defineConfig({ dialect: 'postgresql', schema: './kit-schema.ts', out: './kit-generated' });\n");
execFileSync(process.execPath,[path.join(consumer,'node_modules','drizzle-kit','bin.cjs'),'generate','--config=kit.config.ts'],{cwd:consumer,stdio:'inherit'});
const kitFiles=await readdir(path.join(consumer,'kit-generated'));
if(!kitFiles.some((name)=>name.endsWith('.sql')))throw new Error('drizzle-kit did not generate SQL from package-name imports');
console.log('Installed standard consumer compiles with drizzle-orm 0.45.3');
npm(['install','--prefix',consumer,'--ignore-scripts','--no-audit','--no-fund','drizzle-orm@0.45.2']);
compileInstalled(['standard-consumer.ts']);
compileInstalled(['standard-raw.ts','standard-operations.ts','key-loader.ts']);
console.log('Installed standard consumer compiles with drizzle-orm 0.45.2');
