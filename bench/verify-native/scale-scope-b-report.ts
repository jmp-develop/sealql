import { readFile, writeFile } from 'node:fs/promises';

const dir='bench/results/2026-09-27-native-scale-100m/scope-b';
const matrix=JSON.parse(await readFile(`${dir}/matrix.json`,'utf8'));
const combos=JSON.parse(await readFile(`${dir}/combo-results.json`,'utf8'));
const standalone=JSON.parse(await readFile('bench/results/2026-09-27-native-verification/v3/matrix.json','utf8'));
const replace=JSON.parse(await readFile(`${dir}/replace.json`,'utf8'));
const validation=JSON.parse(await readFile(`${dir}/validation.json`,'utf8'));
const maintenance=JSON.parse(await readFile(`${dir}/maintenance.json`,'utf8'));
const plainIndex=JSON.parse(await readFile(`${dir}/plain-scope-index.json`,'utf8'));
const autovacuum=JSON.parse(await readFile(`${dir}/autovacuum.json`,'utf8'));
const hashes=JSON.parse(await readFile(`${dir}/dist-hashes.json`,'utf8'));
const baseline=new Map(standalone.report.map((r:any)=>[r.case,r]));
const fmt=(x:any)=>typeof x==='number'?x.toFixed(2):x??'—';
const num=(x:any)=>typeof x==='number'?x.toLocaleString('en-US'):x??'—';
const line=(cells:any[])=>`| ${cells.map(x=>String(x)).join(' | ')} |`;
const metrics=(x:any)=>[num(x?.returned),num(x?.candidates),num(x?.sqlCalls),
  fmt(x?.preMs),fmt(x?.sqlMs),fmt(x?.betweenSqlMs),fmt(x?.postMs),fmt(x?.totalMs)];
const lines:string[]=[
  '# 회사 B 범위 검색 시험',
  '',
  '## 데이터와 방법',
  '',
  `- 복제본 번호 **${replace.copy}**의 기존 100,000행을 삭제하고 같은 ID·회사 B scope로 공개 \`sealed.insert\`를 사용해 재암호화했다. 평문 복제본은 scope만 바꿨다.`,
  '- 세 테이블은 각각 전체 100,000,000행이며 회사 B가 100,000행이다. 원본 fixture는 읽기만 했다.',
  `- B 표본 ${num(validation.rows)}행의 인증 복호화와 ${num(validation.tokenColumns)}개 토큰 열 대조가 통과했다.`,
  `- GIN pending pages ${maintenance.pendingBefore.pending_pages} → ${maintenance.pendingAfter.pending_pages}; 세 테이블 ANALYZE 완료.`,
  `- 평문 비교 테이블에 원본 fixture와 동일한 고유 \`(scope_id,id)\` 인덱스를 추가했다. 빌드 ${fmt(plainIndex.elapsedMs/1000)}초, ANALYZE 후 전체 사례를 측정했다.`,
  `- 보조 테이블 autovacuum은 측정 중 일시 중지했고 ${autovacuum.restoredAt?'측정 후 원래 설정으로 복원했다':'아직 복원 전이다'}.`,
  `- dist SHA-256: 측정 전 \`${hashes.before.sha256}\`, 측정 후 \`${hashes.after.sha256}\` (${hashes.before.sha256===hashes.after.sha256?'동일':'불일치'}).`,
  '- findMany는 예열 2회 뒤 평문·제품 순서를 번갈아 7회 측정한 지표별 중앙값이다. count는 각 1회다. SQL 시간은 클라이언트 왕복이며 서버 실행 시간만 뜻하지 않는다. 단발 SQL 제한은 5분, 제품 API의 허용 최대 deadline은 30초다.',
  '- 전처리 = 호출 시작~첫 SQL, DB = SQL 요청~응답 합계, SQL 사이 = SQL 사이의 비 DB 구간, 후처리 = 마지막 SQL 응답~반환이다. 각 지표의 독립 중앙값은 합산해도 합계 중앙값과 같지 않을 수 있다.',
  '- 10만 단독 비교는 `bench/results/2026-09-27-native-verification/v3/matrix.json`이다. 기존 일부 사례는 단발 측정이며 `drain101`은 200건씩 최대 5페이지를 읽었으므로 이번 20건과 직접 비교하지 않는다. 200건·count에는 같은 기준선이 없다.',
  '',
  '## 21개 사례: findMany 20건',
  '',
  line(['사례','방식','대상','실제 일치','결과','DB 후보','SQL 회수','전처리 ms','DB ms','SQL 사이 ms','후처리 ms','합계 ms','10만 단독 합계 ms','10만 단독 DB ms','결과']),
  line(Array(15).fill('---')),
];
for(const r of matrix.report){
  const b:any=baseline.get(r.case);
  for(const path of ['plain','product']){
    const s=r.summary[path],bs=b?.summary?.[path];
    lines.push(line([r.case,path==='plain'?'평문':'제품','B 10만 / 전체 1억',num(r.actualMatches),
      ...metrics(s),r.case==='drain101'?'—':fmt(bs?.totalMs),r.case==='drain101'?'—':fmt(bs?.sqlMs),
      path==='product'?(r.productErrorRuns?`오류 ${r.productErrorRuns}회`:'일치'):'기준']));
  }
}
lines.push('','## AND/OR 5개 사례: findMany 200건','',
  line(['사례','방식','대상','실제 일치','결과','DB 후보','SQL 회수','전처리 ms','DB ms','SQL 사이 ms','후처리 ms','합계 ms','결과']),
  line(Array(13).fill('---')));
for(const r of combos.report)for(const path of ['plain','product']){
  const find=r.find,errors=find.productErrors?.length??0;
  lines.push(line([r.case,path==='plain'?'평문':'제품','B 10만 / 전체 1억',num(find.expectedMatches),
    ...metrics({...find[path],returned:find.returned}),path==='product'?(errors?`오류 ${errors}회`:'일치'):'기준']));
}
lines.push('','## AND/OR 5개 사례: count 1회','',
  line(['사례','방식','대상','실제 일치','반환','DB 후보','SQL 회수','전처리 ms','DB ms','SQL 사이 ms','후처리 ms','합계 ms','결과']),
  line(Array(13).fill('---')));
for(const r of combos.report)for(const path of ['plain','product']){
  const c=r.count,x=c[path],out=x.outcome;
  lines.push(line([r.case,path==='plain'?'평문':'제품','B 10만 / 전체 1억',num(c.expectedMatches),
    num(out.kind==='value'?out.value:null),path==='plain'?'—':num(x.candidates),num(x.sqlCalls),fmt(x.preMs),fmt(x.sqlMs),
    fmt(x.betweenSqlMs),fmt(x.postMs),fmt(x.totalMs),out.kind==='value'?'정확':out.code]));
}
lines.push('','## 해석 한계','',
  '- DB 후보 수는 드라이버가 반환한 행 수이며 SQL 내부에서 검사한 인덱스 항목 수가 아니다.',
  '- 인증 복호화 필드 수는 계측하지 않았다.',
  '- C 로캘에서 한글 평문 LIKE는 전체 스캔일 수 있으므로 해당 평문 대비 배율을 운영 성능 주장에 사용하지 않는다.',
  '- 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.','');
await writeFile(`${dir}/report-ko.md`,lines.join('\n'));
console.log(JSON.stringify({matrixCases:matrix.report.length,comboCases:combos.report.length,report:`${dir}/report-ko.md`}));
