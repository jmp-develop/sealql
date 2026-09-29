import {execFileSync} from 'node:child_process';
import {mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';

// Isolated historical sources; never check out over the shared working tree.
for (const [commit,folder] of [['f9005bd','r9-baseline'],['a15f85a','r9-review-before']]) {
  const root=join('.local',folder);
  if(existsSync(root))throw Error(`Already exists: ${root}`);
  for(const name of execFileSync('git',['ls-tree','-r','--name-only',commit,'src'],{encoding:'utf8'}).trim().split('\n')) {
    const target=join(root,name);mkdirSync(dirname(target),{recursive:true});
    writeFileSync(target,execFileSync('git',['show',`${commit}:${name}`]));
  }
  writeFileSync(join(root,'package.json'),'{"type":"module"}\n');
  writeFileSync(join(root,'tsconfig.json'),execFileSync('git',['show',`${commit}:tsconfig.json`]));
  execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p',join(root,'tsconfig.json')],{stdio:'inherit'});
}
