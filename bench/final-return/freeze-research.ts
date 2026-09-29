import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const sourceTokenColumn=(_table:string,field:string,exact:boolean)=>{let hash=0xcbf29ce484222325n;for(const byte of Buffer.from(field+'/'+(exact?'exact':'substring')))hash=BigInt.asUintN(64,(hash^BigInt(byte))*0x100000001b3n);return 'tokens_'+hash.toString(16).padStart(16,'0');};
const out='bench/results/2026-09-29-final-return';mkdirSync(out,{recursive:true});
const fields=['name','phone','address','memo','email','company'];
writeFileSync(`${out}/research-columns.json`,JSON.stringify(Object.fromEntries(fields.map(f=>[f,{ce:sourceTokenColumn('customers',f,true),cs:sourceTokenColumn('customers',f,false)}])),null,2)+'\n');
const frozen=readFileSync('bench/final-return/research-function.sql','utf8');
if(!frozen.includes('CREATE')||!frozen.includes('FUNCTION'))throw Error('Frozen research SQL is incomplete');
