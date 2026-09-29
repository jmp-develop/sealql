/** Fixed predicates from scale-matrix.ts. Keep the text visible in every report row. */
export type Field = 'name' | 'phone' | 'address' | 'memo' | 'email' | 'company';
export type Leaf = { op: 'eq' | 'contains' | 'startsWith' | 'endsWith'; field: Field; value: string };
export type Node = Leaf | { all: Node[] } | { any: Node[] };
export type Case = { name: string; node: Node; respectWords?: boolean };
const L = (op: Leaf['op'], field: Field, value: string): Leaf => ({ op, field, value });
export const cases: Case[] = [
  { name: 'exact_common', node: L('eq', 'company', '서울서비스 담당') },
  { name: 'exact_mid', node: L('eq', 'company', '서울서비스 중앙지사') },
  { name: 'exact_one', node: L('eq', 'phone', '42-5748-1542') },
  { name: 'exact_zero', node: L('eq', 'phone', '99-0000-0000') },
  { name: 'sub2_common', node: L('contains', 'company', '서비') },
  { name: 'sub_mid', node: L('contains', 'address', '세종대로') },
  { name: 'sub_mid_space', node: L('contains', 'address', '세종대로 25') },
  { name: 'sub_rare', node: L('contains', 'memo', '푸른달') },
  { name: 'sub_long', node: L('contains', 'memo', '상세 안내와 확인 내용 상세 안내와') },
  { name: 'sub_name_suffix', node: L('contains', 'name', 'pshxt') },
  { name: 'sub_zero', node: L('contains', 'memo', '없는표식') },
  { name: 'starts', node: L('startsWith', 'address', '서울') },
  { name: 'ends', node: L('endsWith', 'email', 'biz.test') },
  { name: 'and2', node: { all: [L('eq', 'company', '서울서비스 담당'), L('contains', 'memo', '서비스')] } },
  { name: 'and4', node: { all: [L('eq', 'company', '서울서비스 담당'), L('contains', 'address', '서울'), L('contains', 'memo', '상담'), L('contains', 'email', 'service')] } },
  { name: 'and6', node: { all: [L('contains', 'name', '민서'), L('contains', 'phone', '-5'), L('contains', 'address', '서울'), L('contains', 'memo', '서비스'), L('contains', 'email', 'test'), L('eq', 'company', '서울서비스 담당')] } },
  { name: 'or2', node: { any: [L('eq', 'company', '서울서비스 담당'), L('contains', 'memo', '푸른달')] } },
  { name: 'or3', node: { any: [L('eq', 'phone', '42-5748-1542'), L('eq', 'phone', '21-7100-5875'), L('contains', 'name', 'pshxt')] } },
  { name: 'drain101', node: L('contains', 'memo', '푸른달') },
  { name: 'word_boundary', node: L('contains', 'memo', '서비스 상담'), respectWords: true },
  { name: 'word_inside_longer', node: L('contains', 'memo', '비스 상'), respectWords: true },
];
export const combos = cases.filter(c => ['and2', 'and4', 'and6', 'or2', 'or3'].includes(c.name));
export const fields: Field[] = ['name', 'phone', 'address', 'memo', 'email', 'company'];
export function condition(n: Node): string {
  if ('all' in n) return `(${n.all.map(condition).join(' AND ')})`;
  if ('any' in n) return `(${n.any.map(condition).join(' OR ')})`;
  return `${n.field} ${n.op === 'eq' ? '=' : n.op} "${n.value}"`;
}
export function plainWhere(n: Node, params: unknown[]): string {
  if ('all' in n) return `(${n.all.map(x => plainWhere(x, params)).join(' and ')})`;
  if ('any' in n) return `(${n.any.map(x => plainWhere(x, params)).join(' or ')})`;
  // Normalize only the query term as the original matrix did. Stored *_norm values
  // are used verbatim, including phone values that must not be changed to phone-v1.
  const term = n.value.normalize('NFC').replace(/[！-～]/g, x => String.fromCharCode(x.charCodeAt(0) - 0xff01 + 0x21))
    .replace(/[A-Z]/g, x => x.toLowerCase())
    .replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, '');
  if (/[%_\\]/.test(term)) throw Error('LIKE metacharacter in fixed case');
  params.push(term);
  const p = `$${params.length}`;
  return n.op === 'eq' ? `${n.field}_norm=${p}` : n.op === 'contains'
    ? `${n.field}_norm like '%'||${p}||'%'` : n.op === 'startsWith'
      ? `${n.field}_norm like ${p}||'%'` : `${n.field}_norm like '%'||${p}`;
}
