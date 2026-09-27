import { guard, pool, scopeId, source } from './common.js';
import { oldPieces, oldToken } from './old-oracle.js';
try{
  await guard();
  const columns=(await pool.query("select column_name from information_schema.columns where table_schema=$1 and table_name='customers_std_comp_idx' and column_name like 'tokens_%'",[source])).rows.map(x=>x.column_name as string);
  const row=(await pool.query(`select p.memo_plain,${columns.map(x=>`i.${x}`).join(',')} from ${source}.customers p join ${source}.customers_std_comp_idx i on i.scope_id=p.scope_id and i.row_id=p.id where p.scope_id=$1 order by p.id limit 1`,[scopeId])).rows[0];
  const expected=new Set(oldPieces(row.memo_plain).map(oldToken));
  console.log(JSON.stringify(columns.map(column=>({column,tokens:row[column]?.length,expected:expected.size,shared:row[column]?.filter((x:string)=>expected.has(x)).length}))));
}finally{await pool.end();}
