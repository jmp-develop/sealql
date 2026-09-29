import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {assertDisposable} from '../../test/disposable.js';

export const disposableConfig={host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'} as const;

export async function disposablePool(max=1){
  const pool=new Pool({...disposableConfig,max,idleTimeoutMillis:0,options:'-c statement_timeout=120000'});
  try{
    await assertDisposable(pool);
    assert.equal(Number((await pool.query('show port')).rows[0].port),disposableConfig.port);
    return pool;
  }catch(error){await pool.end();throw error;}
}

export function schemaIdentifier(value:string){
  assert.match(value,/^[a-z][a-z0-9_]{0,62}$/,'Schema must be a simple lower-case PostgreSQL identifier');
  return `"${value}"`;
}
