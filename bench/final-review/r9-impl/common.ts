import {mkdirSync,writeFileSync} from 'node:fs';
export {assert,fields,loadRows,rng,shuffled} from '../../attack-extra/common.js';
export const OUT='bench/results/2026-09-29-final-review/r9-impl';
export function save(name:string,data:unknown){mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/${name}.json`,JSON.stringify(data,null,2)+'\n');}
