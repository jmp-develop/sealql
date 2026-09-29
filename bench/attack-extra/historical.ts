/** Load the committed pre-R9 token functions without building or touching dist. */
import {spawnSync} from 'node:child_process';
import {hash} from 'node:crypto';
import ts from 'typescript';
import {assert} from './common.js';
const result=spawnSync('rtk',['proxy','git','show','f9005bd:src/core/search-tokens.ts'],{encoding:'utf8'});
assert.equal(result.status,0,result.stderr);
export const sourceHash=hash('sha256',result.stdout);
const source=result.stdout.replace(/from '\.\/([^']+)\.js'/g,(_,name:string)=>`from '${new URL(`../../src/core/${name}.ts`,import.meta.url).href}'`);
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
export const historical=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64')) as typeof import('../../src/core/search-tokens.js');
