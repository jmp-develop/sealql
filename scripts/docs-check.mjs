import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checkBenchImports } from './check-bench-imports.mjs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const entry = readFileSync('llms.txt', 'utf8');
const guide = readFileSync('docs/llm-integration.md', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const sample = readFileSync('examples/standard-consumer.ts', 'utf8');
const raw = readFileSync('examples/standard-raw.ts', 'utf8');
const operations = readFileSync('examples/standard-operations.ts', 'utf8');
for (const path of ['.', './drizzle/v0.45']) {
  if (!packageJson.exports[path]) throw Error(`Missing package export: ${path}`);
}
if (packageJson.exports['./postgres']) throw Error('Legacy Postgres export remains');
for (const name of ['createSealer', 'createSealed', 'register', 'findMany', 'count'])
  if (!sample.includes(name)) throw Error(`Sample API drift: ${name}`);
const markdown = dir => readdirSync(dir, { recursive: true })
  .map(path => `${dir}/${path.replaceAll('\\', '/')}`)
  .filter(path => path.endsWith('.md') && !path.startsWith('bench/results/'));
for (const file of ['llms.txt', 'README.md', 'AGENTS.md', 'bench/README.md', ...markdown('docs'), ...markdown('plan')]) {
  const body = readFileSync(file, 'utf8');
  for (const match of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const path = match[1].split('#')[0];
    if (path && !path.includes('://') && !existsSync(resolve(dirname(file), path))) throw Error(`Broken link in ${file}: ${path}`);
  }
  for (const path of body.matchAll(/(?:^|[\s(`])((?:docs|plan|bench|examples)\/[\w./-]+\.(?:md|ts|json))/g)) {
    if (!existsSync(path[1])) throw Error(`Missing referenced file in ${file}: ${path[1]}`);
  }
}
const checkedBenchFiles = checkBenchImports();
const decisions = readdirSync('docs/decisions').filter(name => /^\d{3}-.+\.md$/.test(name));
const decisionIndex = readFileSync('docs/decisions/README.md', 'utf8');
for (const name of decisions) if (!decisionIndex.includes(`(${name})`)) throw Error(`Decision not indexed: ${name}`);
const plans = readdirSync('plan').filter(name => /^\d{3}-.+\.md$/.test(name));
const planIndex = readFileSync('plan/README.md', 'utf8');
for (const name of plans) if (!planIndex.includes(`(${name})`)) throw Error(`Plan not indexed: ${name}`);
if (!entry.includes('docs/llm-integration.md') || !readme.includes('docs/llm-integration.md')) throw Error('AI entry missing');
if (!entry.includes('docs/current-state.md') || !readme.includes('docs/current-state.md')) throw Error('Current-state entry missing');
for (const path of ['examples/standard-consumer.ts', 'examples/standard-raw.ts', 'examples/standard-operations.ts', 'examples/key-loader.ts']) {
  if (!entry.includes(path) || !guide.includes(path)) throw Error(`Unlinked shared example: ${path}`);
}
if (!raw.includes('sealed.search') || !raw.includes('flagsSql') || !operations.includes('sealed.count') || !sample.includes('sealed.insert') || !sample.includes('sealed.open')) throw Error('Raw/operations example drift');
for (const name of ['createSealed', 'register', 'findMany', 'count', 'openRaw', 'reindex'])
  if (!guide.includes(name)) throw Error(`Guide API drift: ${name}`);
for (const path of ['examples', 'llms.txt', 'docs/llm-integration.md', 'docs/current-state.md', 'docs/threat-model.md']) {
  if (!packageJson.files.includes(path)) throw Error(`AI docs missing from package: ${path}`);
}
console.log(`Documentation entry, links, decisions, plans, exports, shared example references, and ${checkedBenchFiles} bench imports PASS`);
