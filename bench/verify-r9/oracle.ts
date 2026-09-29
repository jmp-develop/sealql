import {assert,normalize,words,type Node} from './common.js';
const escaped=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function likeRegex(pattern:string){let expression='^';for(let i=0;i<pattern.length;i++){const ch=pattern[i];if(ch==='\\'){assert(i+1<pattern.length);expression+=escaped(pattern[++i]);}else expression+=ch==='%'?'[\\s\\S]*':ch==='_'?'[\\s\\S]':escaped(ch);}return new RegExp(expression+'$','u');}
export function oracle(n:Node,r:any):boolean{
 if('all'in n)return n.all.every(x=>oracle(x,r));if('any'in n)return n.any.some(x=>oracle(x,r));
 const value=n.respectWords?r.word[n.field]:r.norm[n.field],term=n.respectWords?words(n.value):normalize(n.value);
 return n.op==='eq'?value===term:n.op==='contains'?value.includes(term):n.op==='startsWith'?value.startsWith(term):n.op==='endsWith'?value.endsWith(term):likeRegex(term).test(value);
}
export function koreanLike(n:Node):boolean{return 'all'in n?n.all.some(koreanLike):'any'in n?n.any.some(koreanLike):n.op!=='eq'&&/[\uac00-\ud7af]/.test(n.value);}
