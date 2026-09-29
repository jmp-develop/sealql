import {normalize,fields,type Node} from './common.js';
export function oracle(n:Node,r:any):boolean{
 if('all'in n)return n.all.every(c=>oracle(c,r));if('any'in n)return n.any.some(c=>oracle(c,r));
 const v=r[n.field],q=normalize(n.value);
 if(n.op==='eq')return v===q;if(n.op==='contains')return v.includes(q);if(n.op==='startsWith')return v.startsWith(q);if(n.op==='endsWith')return v.endsWith(q);
 let regex='^',escape=false;for(const c of Array.from(q)){if(escape){regex+=c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');escape=false;}else if(c==='\\')escape=true;else if(c==='%')regex+='[\\s\\S]*';else if(c==='_')regex+='[\\s\\S]';else regex+=c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}if(escape)throw Error('Dangling LIKE escape');return new RegExp(regex+'$','u').test(v);
}
export function normalizedRows(rows:any[]){return rows.map(r=>({id:String(r.id),...Object.fromEntries(fields.map(f=>[f,normalize(String(r[f]))]))}));}
export function plainWhere(n:Node,params:unknown[]):string{
 if('all'in n)return '('+n.all.map(c=>plainWhere(c,params)).join(' AND ')+')';if('any'in n)return '('+n.any.map(c=>plainWhere(c,params)).join(' OR ')+')';
 const q=normalize(n.value),e=q.replace(/[\\%_]/g,c=>'\\'+c);params.push(n.op==='eq'||n.op==='like'?q:n.op==='contains'?'%'+e+'%':n.op==='startsWith'?e+'%':'%'+e);return `${n.field}_norm ${n.op==='eq'?'=':'like'} $${params.length}`;
}
export function match(n:Node,m:any):any{return 'all'in n?m.and(...n.all.map(c=>match(c,m))):'any'in n?m.or(...n.any.map(c=>match(c,m))):m[n.field][n.op](n.value);}
export function koreanLike(n:Node):boolean{return 'all'in n?n.all.some(koreanLike):'any'in n?n.any.some(koreanLike):n.op!=='eq'&&/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(n.value);}
