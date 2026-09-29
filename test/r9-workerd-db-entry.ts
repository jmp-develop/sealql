import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {driverFlow,type DriverFixture} from './r9-driver-flow.js';
export default {async fetch(_request:Request,env:{SCHEMA:string;FIXTURE:string;DATA_DIRECTORY:string}) {
  const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1});
  try {
    if(Number((await pool.query('show port')).rows[0].port)!==56439)throw Error('wrong port');
    if((await pool.query('show data_directory')).rows[0].data_directory!==env.DATA_DIRECTORY)throw Error('wrong cluster');
    return Response.json(await driverFlow(drizzle(pool),env.SCHEMA,JSON.parse(env.FIXTURE) as DriverFixture));
  } catch(error) {return Response.json({ok:false,error:String((error as Error).stack??error)},{status:500});}
  finally {await pool.end();}
}};
