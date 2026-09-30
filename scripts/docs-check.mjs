import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { adapterSurfaces, coreExamples } from './adapter-surfaces.mjs';
import { checkBenchImports } from './check-bench-imports.mjs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const entry = readFileSync('llms.txt', 'utf8');
const core = readFileSync('examples/README.md', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const packaged = path => packageJson.files.some(root => path === root || path.startsWith(`${root}/`));

for (const surface of adapterSurfaces) {
  if (!packageJson.exports[surface.packageExport]) throw Error(`Missing package export: ${surface.packageExport}`);
  if (!existsSync(surface.docs)) throw Error(`Missing adapter guide: ${surface.docs}`);
  if (!entry.includes(surface.docs) || !core.includes(surface.docs.replace(/^examples\//, ''))) throw Error(`Unlinked adapter guide: ${surface.docs}`);
  if (!packaged(surface.docs) || !packaged(surface.examples)) throw Error(`Adapter surface is not packaged: ${surface.id}`);
  const adapterGuide = readFileSync(surface.docs, 'utf8');
  const bodies = [];
  for (const file of surface.files) {
    const path = `${surface.examples}/${file}`;
    if (!existsSync(path)) throw Error(`Missing adapter example: ${path}`);
    bodies.push(readFileSync(path, 'utf8'));
  }
  const examples = bodies.join('\n');
  for (const name of ['createSealed', 'register', 'extraMigrationSql', 'insert', 'update', 'upsert', 'delete',
    'reindex', 'prepareAllSearch', 'where', 'findMany', 'count', 'nextCursor', 'openRaw', 'SealError']) {
    if (!examples.includes(name)) throw Error(`Adapter examples missing ${name}: ${surface.id}`);
  }
}

if (packageJson.exports['./postgres']) throw Error('Legacy Postgres export remains');
for (const path of coreExamples) {
  if (!existsSync(path) || !packaged(path)) throw Error(`Missing packaged core example: ${path}`);
}

const markdown = dir => readdirSync(dir, { recursive: true })
  .map(path => `${dir}/${path.replaceAll('\\', '/')}`)
  .filter(path => path.endsWith('.md') && !path.startsWith('bench/results/'));
// README.md is maintained by hand for people; its stale links are reported, not enforced.
const readmeWarnings = [];
for (const file of ['llms.txt', 'README.md', 'AGENTS.md', 'bench/README.md', ...markdown('docs'), ...markdown('plan')]) {
  const body = readFileSync(file, 'utf8');
  const fail = message => { if (file === 'README.md') readmeWarnings.push(message); else throw Error(message); };
  for (const match of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const path = match[1].split('#')[0];
    if (path && !path.includes('://') && !existsSync(resolve(dirname(file), path))) fail(`Broken link in ${file}: ${path}`);
  }
  for (const path of body.matchAll(/(?:^|[\s(`])((?:docs|plan|bench|examples)\/[\w./-]+\.(?:md|ts|json))/g)) {
    if (!existsSync(path[1])) fail(`Missing referenced file in ${file}: ${path[1]}`);
  }
}
for (const message of readmeWarnings) console.warn(`WARN ${message}`);

const checkedBenchFiles = checkBenchImports();
const decisions = readdirSync('docs/decisions').filter(name => /^\d{3}-.+\.md$/.test(name));
const decisionIndex = readFileSync('docs/decisions/README.md', 'utf8');
for (const name of decisions) if (!decisionIndex.includes(`(${name})`)) throw Error(`Decision not indexed: ${name}`);
const plans = readdirSync('plan').filter(name => /^\d{3}-.+\.md$/.test(name));
const planIndex = readFileSync('plan/README.md', 'utf8');
for (const name of plans) if (!planIndex.includes(`(${name})`)) throw Error(`Plan not indexed: ${name}`);

if (!entry.includes('examples/README.md')) throw Error('AI entry missing');
if (!readme.includes('llms.txt')) throw Error('Human entry missing');
const publicDocs = [core, ...adapterSurfaces.map(surface => readFileSync(surface.docs, 'utf8'))].join('\n');
for (const name of ['createSealer', 'createSealed', 'register', 'where', 'findMany', 'count', 'openRaw', 'reindex', 'prepareAllSearch']) {
  if (!publicDocs.includes(name)) throw Error(`Public guide API drift: ${name}`);
}
for (const path of ['examples', 'llms.txt']) {
  if (!packageJson.files.includes(path)) throw Error(`AI docs missing from package: ${path}`);
}
console.log(`Documentation entry, links, adapter surfaces, decisions, plans, exports, and ${checkedBenchFiles} bench imports PASS`);
