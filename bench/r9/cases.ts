import {cases as r8cases,type Case as R8Case,type Node,type Leaf} from './r8-cases.js';
// Verbatim case definitions from bench/research-list300/m2-fable-list300.ts; SHA256 f42701e57d05cc17de679c1fcc2d8c4cc0468e9a9ced1cf63c722349731a148d
const pick = (n: string) => r8cases.find(c => c.name === n)!;
const L = (op: Leaf['op'], field: any, value: string): Leaf => ({ op, field, value });
const CO = L('eq', 'company', '서울서비스 담당'), MEMO = L('contains', 'memo', '서비스'), RARE = L('contains', 'memo', '푸른달'), ADDR = L('contains', 'address', '서울');
const MORE_CASES: R8Case[] = [
  { name: 'zero_and_common2', node: { all: [CO, L('contains', 'company', '물류')] } },
  { name: 'zero_and_common3', node: { all: [CO, L('contains', 'company', '물류'), MEMO] } },
  { name: 'zero_fragment', node: L('contains', 'memo', '상담서비스') },
  { name: 'zero_fragment_long', node: L('contains', 'memo', '서비스상담서비스상담요청') },
  { name: 'zero_or_all', node: { any: [L('contains', 'memo', '상담서비스'), L('contains', 'name', '서비스상'), L('contains', 'address', '담당서울')] } },
  pick('exact_zero'), pick('sub_zero'),
  { name: 'or4', node: { any: [CO, RARE, L('eq', 'phone', '42-5748-1542'), L('contains', 'name', 'pshxt')] } },
  { name: 'or5', node: { any: [CO, RARE, L('eq', 'phone', '42-5748-1542'), L('contains', 'name', 'pshxt'), L('contains', 'address', '세종대로')] } },
  { name: 'or6', node: { any: [CO, RARE, L('eq', 'phone', '42-5748-1542'), L('contains', 'name', 'pshxt'), L('contains', 'address', '세종대로'), L('endsWith', 'email', 'biz.test')] } },
  { name: 'and2_or_and2', node: { any: [{ all: [CO, MEMO] }, { all: [ADDR, L('contains', 'memo', '상담')] }] } },
  { name: 'or2_and_or2', node: { all: [{ any: [CO, RARE] }, { any: [ADDR, L('contains', 'email', 'service')] }] } },
  { name: 'and3_or_rare', node: { any: [{ all: [CO, MEMO, ADDR] }, RARE] } },
  { name: 'nested3', node: { all: [{ any: [{ all: [CO, MEMO] }, { all: [ADDR, L('contains', 'email', 'test')] }] }, { any: [L('contains', 'phone', '-5'), L('contains', 'name', '민서')] }] } },
  pick('exact_mid'), pick('exact_one'), pick('sub2_common'), pick('sub_mid_space'), pick('sub_long'), pick('word_inside_longer'),
];
const structure = (n: Node): string => 'all' in n ? (n.all.every(x => !('all' in x) && !('any' in x)) ? 'AND ' + n.all.length : '(' + n.all.map(structure).join(') AND (') + ')') : 'any' in n ? (n.any.every(x => !('all' in x) && !('any' in x)) ? 'OR ' + n.any.length : '(' + n.any.map(structure).join(') OR (') + ')') : '1';
const CASES: R8Case[] = [
  pick('exact_common'), { name: 'sub_common_memo', node: { op: 'contains', field: 'memo', value: '서비스' } }, pick('sub_mid'), pick('sub_rare'), pick('starts'), pick('ends'),
  pick('and2'), pick('and4'), pick('and6'), pick('or2'), pick('or3'),
  { name: 'or_and_mix', node: { any: [pick('and2').node, pick('sub_rare').node] } },
  { name: 'word_boundary', node: { op: 'contains', field: 'memo', value: '서비스 상담' }, respectWords: true },
  { name: 'sub45', node: { op: 'contains', field: 'memo', value: '상세안내와확인내용'.repeat(5) } },
];
const SPACE_CASES: R8Case[] = [
  { name: 'space_memo', node: { op: 'contains', field: 'memo', value: '서비스 상담' } },
  { name: 'space_address', node: { op: 'contains', field: 'address', value: '세종대로 25' } },
  { name: 'space_inside', node: { op: 'contains', field: 'memo', value: '비스 상' } },
];

export const BASE_CASES=[...CASES,...MORE_CASES,...SPACE_CASES];
export const CASE_GROUPS={CASES,MORE_CASES,SPACE_CASES};
