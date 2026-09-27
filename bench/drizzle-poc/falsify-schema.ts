import { pgSchema, integer, customType } from 'drizzle-orm/pg-core';
const s=pgSchema('drizzle_falsify');
const pairType=customType<{data:{ct:string;plain:string};driverData:string}>({dataType:()=> 'drizzle_falsify.seal_pair',toDriver:v=>`(${v.ct},${v.plain})`});
export const pairs=s.table('pairs',{id:integer('id').primaryKey(),sealed:pairType('sealed')});
