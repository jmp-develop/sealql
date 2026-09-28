import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const source='bench/research-list300/m2-fable-list300.ts',s=readFileSync(source,'utf8');
const header="import {cases as r8cases,type Case as R8Case,type Node,type Leaf} from '../verify-native/r8-cases.js';\n";
const first=s.slice(s.indexOf('const pick ='),s.indexOf('const leafFields ='));
const space=s.slice(s.indexOf('const SPACE_CASES:'),s.indexOf('function evalNode('));
writeFileSync('bench/research-task4/cases.ts',header+'// Verbatim case definitions from '+source+'; SHA256 '+createHash('sha256').update(s).digest('hex')+'\n'+first+space+'\nexport const BASE_CASES=[...CASES,...MORE_CASES,...SPACE_CASES];\nexport const CASE_GROUPS={CASES,MORE_CASES,SPACE_CASES};\n');
