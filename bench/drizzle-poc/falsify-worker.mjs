import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { pgTable, text, customType } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { probe } from './falsify-crypto.mjs';
export default {async fetch(){
 const als=new AsyncLocalStorage(), events=[];
 const scoped=customType({dataType:()=> 'text',toDriver:v=>{events.push(['to',als.getStore()]);return v;},fromDriver:v=>{events.push(['from',als.getStore()]);return v;}});
 const table=pgTable('fake',{value:scoped('value')});
 const db=drizzle(async(_query,params)=>{await Promise.resolve();return {rows:[[params?.[0]??'x']]};});
 const scopes=await Promise.all(['A','B'].map(s=>als.run(s,async()=>{const rows=await db.select({value:table.value}).from(table).where(eq(table.value,s));return rows[0].value;})));
 const before=events.length;
 const outside=await als.run('OUT',()=>db.select({value:table.value}).from(table).where(eq(table.value,'OUT')));
 return Response.json({crypto:await probe(),scopes,events,outside,outsideEvents:events.slice(before)});
}};
