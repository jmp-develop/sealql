import {execFileSync} from 'node:child_process';
import {mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
const commit='04994b2',root='.local/r9-email-before';
if(existsSync(root))throw Error(`Already exists: ${root}`);
for(const name of execFileSync('git',['ls-tree','-r','--name-only',commit,'src'],{encoding:'utf8'}).trim().split('\n')) {
 const target=join(root,name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,execFileSync('git',['show',`${commit}:${name}`]));
}
writeFileSync(join(root,'package.json'),'{"type":"module"}\n');
writeFileSync(join(root,'tsconfig.json'),execFileSync('git',['show',`${commit}:tsconfig.json`]));
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p',join(root,'tsconfig.json')],{stdio:'inherit'});
