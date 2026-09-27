import { writeFile, mkdir } from 'node:fs/promises';
import { profiles } from '../../src/core/search-tokens.js';
import { compileSearch, type SearchNode } from '../../src/core/search-predicate.js';
import { candidateStatement } from '../../src/adapters/postgres/search-sql.js';
import { binding, fields, guard, pool, schema, scopeId, sealer } from './common.js';

const all = [
  { name: 'address_mid', node: { op: 'contains', field: 'address', value: '세종대로' } },
  { name: 'email_end', node: { op: 'endsWith', field: 'email', value: 'biz.test' } },
  { name: 'and4', node: { op: 'all', children: [
    { op: 'eq', field: 'company', value: '서울서비스 담당' }, { op: 'contains', field: 'address', value: '서울' },
    { op: 'contains', field: 'memo', value: '상담' }, { op: 'contains', field: 'email', value: 'service' },
  ] } },
  { name: 'and6', node: { op: 'all', children: [
    { op: 'contains', field: 'name', value: '민서' }, { op: 'contains', field: 'phone', value: '-5' },
    { op: 'contains', field: 'address', value: '서울' }, { op: 'contains', field: 'memo', value: '서비스' },
    { op: 'contains', field: 'email', value: 'test' }, { op: 'eq', field: 'company', value: '서울서비스 담당' },
  ] } },
  { name: 'sub_long', node: { op: 'contains', field: 'memo', value: '상세 안내와 확인 내용 상세 안내와' } },
  { name: 'word_boundary', node: { op: 'contains', field: 'memo', value: '서비스 상담', respectWords: true } },
  { name: 'sub_zero', node: { op: 'contains', field: 'memo', value: '없는표식' } },
  { name: 'exact_one', node: { op: 'eq', field: 'phone', value: '42-5748-1542' } },
] as const;
const report: unknown[] = [];
try {
  await guard();
  for (const c of all) for (const skip of [false, true]) {
    const b = binding('customers', skip);
    const stored = Object.entries(b.model.fields).flatMap(([field, spec]) => profiles(b.model.id, field, spec));
    const compiled = await compileSearch(c.node as SearchNode, b.model, stored, sealer.ring(b.model.id), scopeId);
    const statement = candidateStatement(b.definition, b.storage, scopeId, compiled);
    const suffix = skip ? '_skip' : '';
    const sql = `select id,${fields.map(f => `${f}_ct`).join(',')} from ${schema}.customers${suffix} where scope_id=$1 and ${statement.text.replace(/\$(\d+)/g, (_, n) => '$' + (Number(n) + 1))} order by id limit 27`;
    const result = (await pool.query(`explain (analyze,buffers,format json) ${sql}`, [scopeId, ...statement.values])).rows[0]['QUERY PLAN'][0];
    report.push({ case: c.name, variant: skip ? 'skip' : 'next', explain: result });
    const flatten = (p: any): string[] => [`${p['Node Type']}:${p['Plan Rows']}/${p['Actual Rows']}`, ...(p.Plans ?? []).flatMap(flatten)];
    console.log(JSON.stringify({ case: c.name, variant: skip ? 'skip' : 'next', ms: result['Execution Time'], path: flatten(result.Plan) }));
    const bounded = candidateStatement(b.definition, b.storage, scopeId, compiled, { limit: 27 });
    const boundedSql = `select id,${fields.map(f => `${f}_ct`).join(',')} from ${schema}.customers${suffix} where scope_id=$1 and ${bounded.text.replace(/\$(\d+)/g, (_, n) => '$' + (Number(n) + 1))} order by id limit 27`;
    const hybridResult = (await pool.query(`explain (analyze,buffers,format json) ${boundedSql}`, [scopeId, ...bounded.values])).rows[0]['QUERY PLAN'][0];
    report.push({ case: c.name, variant: skip ? 'skip' : 'next', method: 'hybrid', explain: hybridResult });
    console.log(JSON.stringify({ case: c.name, variant: skip ? 'skip' : 'next', method: 'hybrid', ms: hybridResult['Execution Time'], path: flatten(hybridResult.Plan) }));
  }
  await mkdir('bench/results/2026-09-27-standard-next-sqlplan', { recursive: true });
  await writeFile('bench/results/2026-09-27-standard-next-sqlplan/explain-compare.json', JSON.stringify(report, null, 2) + '\n');
} finally { await pool.end(); }
