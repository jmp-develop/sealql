import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
const file='bench/results/2026-09-28-task3/measure.json';
const a=JSON.parse(readFileSync(file,'utf8'));
assert(a.finished);assert.equal(a.pid,a.pidEnd);assert.equal(a.rows.length,8);assert.equal(a.plans.length,48);
for(const r of a.rows)for(const p of a.paths)assert.equal(r.runs[p].length,7);
const f=(n,d=2)=>Number(n).toFixed(d),n=x=>Number(x).toLocaleString('en-US');
const labels={plain:'평문',B_original:'현재 B 원본',B16:'B16 대조군',k2:'k=2',k4:'k=4',m8:'m=8'};
const cn={common:'회사 흔함',rare:'회사 드묾',and2:'AND2',or2:'OR2'};
function table(headers,rows){return '| '+headers.join(' | ')+' |\n| '+headers.map(()=>'---').join(' | ')+' |\n'+rows.map(r=>'| '+r.join(' | ')+' |').join('\n');}
function timing(metric){return table(['조건·연산',...a.paths.map(p=>labels[p])],a.rows.map(r=>[cn[r.name]+' '+(r.mode==='count'?'count':'목록300'),...a.paths.map(p=>f(r.summary[p][metric])+' / '+f(r.summary[p][metric]/r.summary.plain[metric])+'배')]));}
function subqueryCandidates(name,path){const plan=a.plans.find(p=>p.name===name&&p.path===path&&p.mode==='list').plan[0].Plan;let found;function walk(node){if(node['Node Type']==='Subquery Scan')found=(node['Actual Rows']+(node['Rows Removed by Filter']??0))*node['Actual Loops'];for(const child of node.Plans??[])walk(child);}walk(plan);return found??300;}
const tags=a.distribution.flatMap(r=>Array.from({length:8},(_,v)=>createHmac('sha256',Buffer.alloc(32,7)).update(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','customers','company','task3-contention8',Number(r.company_token),v].join('\0')).digest().readUInt16BE()));
const b16=a.rows.find(r=>r.name==='rare'&&r.mode==='list').summary.B16.sqlMs;
const report=`# 과제3 — 회사명 정확 번호 보완 DB 실측 (m1-astra)

## 실패·미검증

- 실행 실패·결과 불일치 **없음**: 4조건 × 2연산 × 6경로 × 10회 = **480회 평문 동일성 단언 통과**. 실제 중앙값 표본은 경로·조건·연산마다 7회다.
- 보안 공격 성공률, 관리형 쓰기·부분 수정·삭제·동시성, 다른 키·scope·데이터 분포는 **측정 안 함**. 보안성 결론은 이 DB 성능 실험만으로 내리지 않는다.
- 목록300은 **id만 반환**, id 오름차순 최대 300개다. 고객 필드 전체를 반환하는 시간은 측정 안 함. count 반환은 정확한 정수와 동일성 검사이며, 이번 fixture 범위의 검증이다.
- AND2·OR2는 한글 LIKE가 들어간 C 로캘 평문 기준이다. 이 배율을 일반 로캘·운영 성능으로 외삽하지 않는다. 회사명 단독은 B-tree 정확 일치 기준이다.
- 기존 B 원본은 6칸 보조 표, 새 표들은 회사·메모 2칸 보조 표다. **번호 설계의 효과는 동일 2칸 B16 대조군과 비교**해야 한다. m8은 ID 순으로 5천 행씩 적재해 다른 파생 표와 물리 페이지 배치까지 같지는 않다. 암호문 본문을 포함한 전체 DB 용량·제품 성능이 아니다.

## 조건·방법

${table(['조건','조건 전문(공백 제거 등 기존 정규화 적용)','평문 일치'],[
 ['회사 흔함','company = "서울서비스 담당"','28,331'],
 ['회사 드묾','company = "서울서비스 중앙지사"','1,770'],
 ['AND2','company = "서울서비스 담당" AND memo contains "서비스"','21,176'],
 ['OR2','company = "서울서비스 담당" OR memo contains "푸른달"','28,400'],
])}

- 기존 fixture에서 파생한 research_u, **총 100,000행·단일 scope 100,000행**, 회사명 16종. 기존 표는 읽기만 했다.
- 같은 연결 세션(PID ${a.pid}), 측정 ${a.started}–${a.finished} UTC. 최초 1회 별도 저장 → 예열 2회 → 경로 순서를 회전한 교차 7회 중앙값. 캐시를 비우지 않아 최초 실행을 cold라고 부르지 않는다.
- 락 21:37:32Z 취득, 적재·색인 약 37.5초 후 측정, 21:38:35Z 해제. **동시 외부 적재·측정 겹침 없음**: 코디네이터 확인(mongod 종료, 21:10Z 이후 다른 측정 없음). 병렬 worker 허용 등 DB 설정은 경로마다 변경하지 않았다.
- 각 측정은 SQL 요청 1회. count는 scalar 1행, 목록은 ID 300행 반환. 인증 복호화 필드 수 0. SQL 시간은 요청 직전부터 응답까지, 전체 시간은 질의 번호·도장 생성부터 ID/정수 결과 구성까지다. 최초값·개별 7회·준비시간은 원자료에 보존했다.
- 재실행 명령: **rtk proxy node --import tsx bench/research-task1/pb3-astra.ts measure**. 스크립트 deadline은 해당 실행의 승인된 마감으로 바꿔야 한다. all은 이미 존재하는 연구 표를 발견하면 중단하며 덮어쓰지 않는다.

## 구현한 비교군

${table(['경로','회사명 후보 번호','DB 정확 판정·구조'],[
 ['현재 B 원본','기존 exact16 번호를 담은 토큰','기존 b_customers_tags 6칸 그대로 읽음'],
 ['B16 대조군','기존 토큰의 실제 16비트 번호 추출','회사 salt+jx, 메모 cs+salt+jt만 보존한 동일 2칸 구조'],
 ['k=2 / k=4','16비트 번호의 상위 2 / 4비트','기존 회사별 행 도장 그대로, 후보 확대분을 DB에서 제거'],
 ['m=8','원래 16비트 번호와 변형 번호(0..7)를 별도 도메인 HMAC으로 16비트화','행마다 randomInt(8) 배정; 검색 시 8번호를 ANY로 전달'],
])}

현재 제품 토큰의 하위 16비트는 0이므로 (unsignedToken >> 16) & 65535로 실제 번호를 추출했다. m=8은 공개 비트 이어 붙이기로 원번호를 남기지 않으며, 새 k/m 표에 기존 회사 ce·cs 또는 역매핑을 저장하지 않았다. 연구 고정 PRF 키·scope를 재사용하되 contention용 도메인을 분리했다. 회사 16종에서 변형 128개 중 실제 고유 번호는 **${new Set(tags).size}개**, 모든 회사에서 8개 변형이 관측됐다(이번 고정 키의 사실). 메모 구조와 행별 도장은 기존 B와 같다. k=2·4는 제품 최소 exact 8비트를 변경한 것이 아니라 별도 연구 표다.

## SQL 요청–응답 중앙값: ms / 평문 배율

${timing('sqlMs')}

## 전체 시간 중앙값: ms / 평문 배율

${timing('totalMs')}

## 후보 수와 LIMIT 동작

아래 후보는 **LIMIT 이전 전체 후보집합**이다. 실제 일치 수와 별도로 후보 전용 SQL로 셌다. B 원본·B16·m8은 이번 네 조건에서 동일 후보 수였다.

${table(['조건','최종 일치','현재 B / B16 / m8 후보','k=2 후보','k=4 후보'],a.rows.filter(r=>r.mode==='count').map(r=>[cn[r.name],n(r.matches),n(r.candidates.B16),n(r.candidates.k2),n(r.candidates.k4)]))}

아래는 측정 뒤 별도 EXPLAIN ANALYZE에서 **행별 판정에 들어간 목록 후보 수**(Subquery Scan의 반환+제거 행)다. 각 경로의 최종 반환은 300개이며, 목록의 원본 스캔·정렬은 이보다 더 많은 행을 처리할 수 있다.

${table(['조건',...a.paths.filter(p=>p!=='plain').map(p=>labels[p])],Object.keys(cn).map(name=>[cn[name],...a.paths.filter(p=>p!=='plain').map(p=>n(subqueryCandidates(name,p)))]))}

## EXPLAIN으로 확인한 차이

1. **k=2 드문 값:** 후보 1,770→21,320(12.05배). count에서 Bitmap Heap Scan이 도장으로 19,550행을 제거했다. 목록은 100,000행 Seq Scan → 후보 21,320행 정렬 → 3,561개 판정 중 3,261개 제거 → 300개 반환. B16의 후보 300개만 순서대로 읽는 Index Scan과 달라 SQL ${f(b16)}→37.11ms다. 후보 확대와 LIMIT 계획 변화가 함께 비용을 만든다.
2. **흔한 값의 역전:** B16·m8 count는 직렬 Bitmap Heap Scan(후보 28,331개), k=2·4는 worker 2개를 쓰는 Parallel Seq Scan이다. k의 SQL 55–58ms 대 B16 89ms는 후보가 줄어든 결과가 아니다. k 후보는 각각 40,012·38,799개다. 현재 B 원본도 병렬 Seq Scan이며 70.70ms다. 동일 병렬도 강제 재측정은 하지 않았다.
3. **m=8 드문 값 목록:** 후보는 1,770개로 같지만 ANY(8번호)의 Index Scan 뒤 Sort가 생겨 1,770개를 읽고 정렬한 후 300개 반환한다. B16은 단일 번호의 인덱스 순서로 300개에서 멈춘다(1.33→2.91ms). count 비용은 B16 17.03ms, m8 18.16ms로 가까웠다.
4. **AND2 목록:** 후보 BitmapAnd → Heap Scan → Sort가 먼저 실행된다. B16은 후보 21,176개를 모아 정렬하고 300개 판정, k=2는 24,145개를 모아 정렬하고 340개 판정이다. 그래서 B16 63.69ms, k=2 69.27ms, m8 67.16ms다. 평문은 회사명 B-tree에서 메모 조건을 적용해 393개를 읽고 300개 반환했다. 현재 B 원본의 AND2 count 377.17ms 대 2칸 B16 103.92ms 차이를 번호 설계 개선으로 주장할 수 없다.

48개 EXPLAIN(ANALYZE,BUFFERS) 원문·SQL은 원자료의 plans에 있다. Shared Read Blocks는 PostgreSQL 버퍼 미스를 뜻하며 물리 디스크 읽기라고 단정하지 않는다.

## 저장 용량 (각각 100,000행)

MB = 1,000,000바이트. total은 인덱스·TOAST·부속 저장을 포함한다. 현재 B 원본은 6칸이므로 2칸 평문과 용량 배율을 비교하지 않았다. 새 B 표의 회사 exact만 남기고 메모 substring을 보존한 연구 구조이며 전체 라이브러리 저장량이 아니다.

${table(['표','행 수','heap MB','index MB','total MB','2칸 평문 대비'],a.meta.map(r=>[r.table,n(r.n),f(r.heap/1e6),f(r.indexes/1e6),f(r.total/1e6),r.path==='B_original'?'비교 제외(6칸)':f(r.total/a.meta[0].total)+'배']))}

## 가설 검증표

${table(['가설','판정','관측 근거'],[
 ['후보 번호를 거칠게 해도 기존 도장이 이번 count·목록 정답을 유지한다','통과(이번 fixture)','k2·k4 모두 4조건·2연산·10회 평문과 같음'],
 ['k2 후보 확대 비용은 작다','기각','드문 값 후보 12.05배; 목록 SQL 평문72.01배 / B16 대비27.98배'],
 ['k4가 모든 회사에서 여러 값을 섞는다','기각','드문 회사는 k4=14를 단독 사용, 후보1,770개 그대로'],
 ['m8의 후보 수·count 비용은 B16과 비슷하다','이번 4조건에서 지지','후보 수 모두 동일, count B16 대비 약0.99–1.07배'],
 ['m8은 목록에도 추가 비용이 없다','기각','드문 값8번호 정렬 때문에 B16 대비2.19배'],
 ['k/m 방식이 공격 복원을 막는다','측정 안 함','이 담당은 DB 성능·정답 검사만 수행, 공격 결과 대체 불가'],
])}

## 결론 3줄

1. **k=2는 드문 값 조회 비용이 크다:** 후보 12.05배, count 66.61ms(평문94.01배), 목록300 37.11ms(평문72.01배)다.
2. **k=4는 이번 드문 값에서 후보 혼합이 없고, m=8은 count 비용을 대체로 유지했지만 드문 값 목록이 2.19배 느려졌다(B16 대비).** 보안 이득은 별도 공격 검증 없이는 판단하지 않는다.
3. **네 조건 모두 정답은 유지했으나 평문 약2배 목표를 충족하지 못했다.** 현재 B 원본·동일 구조 대조군·새 표 및 원자료를 보존했고, 병렬 계획·표 폭·목록 정렬 차이를 분리해 보고했다.

## 증거·검증

- [측정·적재 스크립트](../../bench/research-task1/pb3-astra.ts)
- [원자료: 반복·후보·용량·48개 계획](../../bench/results/2026-09-28-task3/measure.json)
- [적재 기록](../../bench/results/2026-09-28-task3/load.json)
- TypeScript strict 정적 검사 통과(tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --esModuleInterop bench/research-task1/pb3-astra.ts).
- assertDisposable 및 SHOW port=56439 확인 후 DB 접근. 기존 표 수정·커밋·표 삭제 없음. 과거 공격 수치·다른 연구자 노트를 이 보고의 실측으로 사용하지 않았다.
`;
writeFileSync('.local/research/task3-m1-astra.md',report);
console.log('report written',report.length,'chars',new Date().toISOString());
