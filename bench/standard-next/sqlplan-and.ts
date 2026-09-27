import { writeFile } from 'node:fs/promises';
import { compileSearch, type SearchNode } from '../../src/core/search-predicate.js';
import { profiles } from '../../src/core/search-tokens.js';
import { candidateStatement } from '../../src/adapters/postgres/search-sql.js';
import { binding, fields, guard, pool, schema, scopeId, sealer } from './common.js';

const leaf = (field: string, op: 'contains' | 'eq', value: string) => ({ field, op, value });
const cases = [
  { name: 'and4', node: { op: 'all', children: [leaf('company', 'eq', '서울서비스 담당'), leaf('address', 'contains', '서울'), leaf('memo', 'contains', '상담'), leaf('email', 'contains', 'service')] } },
  { name: 'and6', node: { op: 'all', children: [leaf('name', 'contains', '민서'), leaf('phone', 'contains', '-5'), leaf('address', 'contains', '서울'), leaf('memo', 'contains', '서비스'), leaf('email', 'contains', 'test'), leaf('company', 'eq', '서울서비스 담당')] } },
] as const;
const report: any = { extensions: [], indexes: [], plans: [] };
try {
  await guard();
  await pool.query('create extension if not exists pgstattuple');
  report.environment = { extensionCommand: 'CREATE EXTENSION IF NOT EXISTS pgstattuple', host: '127.0.0.1', port: 56439 };
  report.extensions = (await pool.query("select extname from pg_extension where extname in ('pgstattuple','pageinspect')")).rows;
  report.tableStats = (await pool.query("select relname,n_live_tup,last_analyze,last_autoanalyze,vacuum_count,autovacuum_count from pg_stat_all_tables where schemaname=$1 and relname in ('customers_seal_index','customers_skip_seal_index')", [schema])).rows;
  const statFunction = report.extensions.some((x: any) => x.extname === 'pgstattuple');
  for (const skip of [false, true]) {
    const b = binding('customers', skip), suffix = skip ? '_skip' : '';
    const indexTable = `${schema}.customers${suffix}_seal_index`;
    const indexes = (await pool.query(`select indexname,indexdef from pg_indexes where schemaname=$1 and tablename=$2`, [schema, `customers${suffix}_seal_index`])).rows;
    for (const index of indexes) {
      const options = (await pool.query('select reloptions from pg_class where oid=$1::regclass', [`${schema}.${index.indexname}`])).rows[0].reloptions;
      let pending;
      if (statFunction && /using gin/i.test(index.indexdef)) pending = (await pool.query('select * from pgstatginindex($1::regclass)', [`${schema}.${index.indexname}`])).rows[0];
      report.indexes.push({ variant: skip ? 'skip' : 'next', ...index, options, pending });
    }
    for (const c of cases) {
      const stored = Object.entries(b.model.fields).flatMap(([field, spec]) => profiles(b.model.id, field, spec));
      const compiled = await compileSearch(c.node as SearchNode, b.definition, stored, sealer.ring(b.model.id), scopeId);
      const statement = candidateStatement(b.definition, b.storage, scopeId, compiled);
      const sql = `select id,${fields.map(f => `${f}_ct`).join(',')} from ${schema}.customers${suffix} where scope_id=$1 and ${statement.text.replace(/\$(\d+)/g, (_, n) => '$' + (Number(n) + 1))} order by id limit 27`;
      const plan = (await pool.query(`explain (analyze,buffers,format json) ${sql}`, [scopeId, ...statement.values])).rows[0]['QUERY PLAN'][0];
      report.plans.push({ case: c.name, variant: skip ? 'skip' : 'next', mode: 'full', explain: plan });
      for (const child of compiled.children) {
        if (child.op !== 'leaf') continue;
        const mapped = b.storage.index!.profiles![child.leaf.profile.indexId];
        const exact = child.leaf.profile.mode === 'exact';
        const predicate = exact ? `(${mapped.tokens})[1]=$2::bigint` : `${mapped.tokens} @> $2::bigint[]`;
        const token = exact ? child.leaf.tokens[0] : child.leaf.tokens;
        const subplan = (await pool.query(`explain (analyze,buffers,format json) select row_id from ${indexTable} where scope_id=$1 and ${predicate}`, [scopeId, token])).rows[0]['QUERY PLAN'][0];
        report.plans.push({ case: c.name, variant: skip ? 'skip' : 'next', mode: child.leaf.node.field, tokenCount: child.leaf.tokens.length, explain: subplan });
      }
    }
  }
  await writeFile('bench/results/2026-09-27-standard-next-sqlplan/and-diagnostics.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ extensions: report.extensions, indexes: report.indexes.map((x: any) => ({ name: x.indexname, options: x.options, pending: x.pending })), plans: report.plans.map((x: any) => ({ case: x.case, variant: x.variant, mode: x.mode, ms: x.explain['Execution Time'], actualRows: x.explain.Plan['Actual Rows'] })) }));
} finally { await pool.end(); }
