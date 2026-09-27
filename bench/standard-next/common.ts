import { performance } from 'node:perf_hooks';
import { Pool, type PoolClient } from 'pg';
import { createSealer } from '../../src/index.js';
import { bindSealed, definePostgresStorage, defineSealedModel, postgresExecutor, type SealedSqlExecutor } from '../../src/adapters/postgres/sealed-index.js';
import { assertDisposable } from '../../test/disposable.js';

export const source = 'bench_realistic_100k';
export const schema = 'bench_standard_next_100k';
export const scopeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const fields = ['name','phone','address','memo','email','company'] as const;
export type Table = 'customers'|'tickets';
export const tables: Table[] = ['customers','tickets'];
export const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 8, options: '-c statement_timeout=120000' });
export const sealer = createSealer({ key: new Uint8Array(32).fill(93) });
export type Event = { sqlMs: number; rows: number; text: string };
export let events: Event[] | null = null;
export function setEvents(value: Event[] | null) { events = value; }
export async function query(text: string, values: unknown[] = []) {
  const started = performance.now();
  const result = await pool.query(text, values);
  events?.push({ sqlMs: performance.now()-started, rows: result.rows.length, text });
  return result;
}
export async function guard() {
  await assertDisposable(pool);
  if (Number((await pool.query('show port')).rows[0].port) !== 56439) throw new Error('Wrong port');
}
export function executor(): SealedSqlExecutor {
  const onClient = (client: PoolClient): SealedSqlExecutor => {
    const tx: SealedSqlExecutor = { query: async statement => {
      const t=performance.now(); const r=await client.query(statement.text,statement.values);
      events?.push({sqlMs:performance.now()-t,rows:r.rows.length,text:statement.text});
      return {rows:r.rows,rowCount:r.rowCount};
    }, transaction: fn => fn(tx) }; return tx;
  };
  return postgresExecutor({ query: statement => query(statement.text, statement.values), transaction: async fn => {
    const client=await pool.connect(); try { await client.query('begin'); const result=await fn(onClient(client)); await client.query('commit'); return result; }
    catch(error) { await client.query('rollback'); throw error; } finally { client.release(); }
  } });
}
export function binding(table: Table, skip=false) {
  const suffix=skip?'_skip':'';
  const tableName=skip && table==='customers' && process.env.SEALQL_BENCH_PRODUCT_MULTI_TABLE
    ? process.env.SEALQL_BENCH_PRODUCT_MULTI_TABLE : `${table}${suffix}`;
  const model=defineSealedModel({ id:`realistic-${table}-standard`, identity:{scope:'uuid',row:'uuid',revision:'bigint'},
    fields:Object.fromEntries(fields.map(f=>[f,{type:'text' as const,nullable:false,
      search:{exact:true as const,substring:{wordBoundary:true,skipGrams:skip}}}])) as Record<typeof fields[number], {type:'text';nullable:false;search:{exact:true;substring:{wordBoundary:true;skipGrams:boolean}}}>,
    public: table==='tickets'?{customer_id:{type:'uuid' as const,nullable:false}}:{},
  });
  const mapping=definePostgresStorage(model,{schema,table:tableName,identity:{scope:'scope_id',row:'id',revision:'revision'},
    fields:Object.fromEntries(fields.map(f=>[f,`${f}_ct`])) as Record<typeof fields[number],string>,
    public:table==='tickets'?{customer_id:'customer_id'}:{},indexTable:`${tableName}_seal_index`});
  return {...mapping,model,repo:bindSealed({sealer,definition:mapping.definition,storage:mapping.storage,executor:executor()}).forScope({scopeId})};
}
