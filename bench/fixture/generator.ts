/**
 * Plaintext generator of the synthetic `bench_realistic_100k` fixture (customers, tickets).
 * Extracted from the original loader; encryption and DB loading are not included.
 * The RNG stream is shared: all customers 0..rows-1 are generated first, then all tickets.
 * Usage: node --import tsx bench/fixture/generator.ts [rows=100000] > rows.jsonl
 */
export const SEED = 0x20260924;
export const SCOPE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const FIELDS = ['name', 'phone', 'address', 'memo', 'email', 'company'] as const;
export type Field = typeof FIELDS[number];
export type Table = 'customers' | 'tickets';
export type Data = Record<Field, string>;

const names = ['김민서', '박지훈', '이서연', '최도윤', '정하린', '한유진', 'Alex Kim', 'Mina Park', '山田花子', 'José Rivera'];
const companies = ['서울서비스', '부산물류', '한빛테크', '도쿄상사', 'Northwind Labs', 'Acme Logistics', 'Blue River', 'Órbita Group'];
const streets = ['서울 중구 세종대로', '부산 해운대구 센텀로', '대전 유성구 대학로', '인천 연수구 송도과학로', 'Tokyo Chiyoda', 'Madrid Gran Vía'];
const memos = ['배송 확인 요청', '정기 서비스 상담', '계약서 검토 완료', '빠른 회신 바랍니다', 'invoice follow up', 'support case reopened', '서비스 일정 조정', '주소 변경 접수'];
const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function id(table: Table, i: number): string {
  return `${table === 'customers' ? '10000000' : '20000000'}-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`;
}

/** Streams rows in the original order; each ticket i references customer i. */
export function* generate(rows: number): Generator<{ table: Table; id: string; scopeId: string; customerId?: string; data: Data }> {
  let state = SEED;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const choose = <T>(values: readonly T[]) => values[random() % values.length];
  const suffix = (n: number) => { let s = ''; for (let i = 0; i < n; i++) s += alphabet[random() % alphabet.length]; return s; };
  const rowData = (table: Table, i: number): Data => {
    const common = i % 5 === 0, rare = i % 997 === 0, long = i % 41 === 0;
    const baseName = common ? '김민서' : choose(names);
    const baseCompany = common ? '서울서비스' : choose(companies);
    const baseMemo = rare ? '희귀표식 푸른달' : common ? '정기 서비스 상담' : choose(memos);
    const token = suffix(5);
    return {
      name: `${baseName} ${token}`,
      phone: `${10 + random() % 80}-${String(random() % 10000).padStart(4, '0')}-${String(random() % 10000).padStart(4, '0')}`,
      address: `${choose(streets)} ${1 + random() % 999} ${table === 'tickets' ? '접수' : '고객'}`,
      memo: long ? `${baseMemo} · ${'상세 안내와 확인 내용 '.repeat(4)}${token}` : `${baseMemo} ${token}`,
      email: `${suffix(5)}.${i.toString(36)}@${common ? 'example.test' : choose(['mail.test', 'biz.test', 'service.test'])}`,
      company: `${baseCompany} ${i % 17 === 0 ? '중앙지사' : '담당'}`,
    };
  };
  for (const table of ['customers', 'tickets'] as const) for (let i = 0; i < rows; i++) {
    yield { table, id: id(table, i), scopeId: SCOPE, ...(table === 'tickets' ? { customerId: id('customers', i) } : {}), data: rowData(table, i) };
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('bench/fixture/generator.ts')) {
  for (const row of generate(Number(process.argv[2] ?? 100000))) process.stdout.write(`${JSON.stringify(row)}\n`);
}
