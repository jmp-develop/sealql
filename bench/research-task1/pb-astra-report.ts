/** Offline report and consistency audit; never imports the DB runner. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const root='bench/results/2026-09-29-task1';
const read=(s:string)=>JSON.parse(readFileSync(`${root}/pb-astra${s}.json`,'utf8'));
const loads=[read('-load'),read('-w4-load')],runs=[read('-measure'),read('-w4-measure')],plans=[read('-plans'),read('-w4-plans')],short=read('-w4-short'),baseline=read('-baseline');
assert.deepEqual(read('-queries'),read('-w4-queries'));
for(const rows of [...runs,short])for(const r of rows){assert(!r.error);assert.equal(r.appDecrypts,0);for(const path of ['plain','position'])assert.equal(r.runs[path].length,7);}
assert.equal(runs[0].length,10);assert.equal(runs[1].length,10);assert.equal(short.length,4);
const f=(n:number)=>n.toFixed(2),n=(v:number)=>v.toLocaleString('en-US');
const rel=(name:string)=>baseline.sizes.find((r:any)=>r.relname===name),plain=rel('pb_astra_plain'),b=rel('pb_astra_b'),p2=rel('pb_astra_w2'),p4=rel('pb_astra_w4');
const lines:string[]=['# 개선 B = 위치 도장: 고객 10만 행 DB 가능성 검증 (m1-astra)','',
'## 실패·미검증','',
'- 최종 긴 조건 5개×count/목록×창 길이2·4 = 20개 비교와 창 길이4의 짧은 조건 4개 비교는 모두 평문과 일치했다. 각 비교는 첫 실행 별도 + 예열2 + 교차7이고 원 반복값을 보존했다.',
'- 목록은 **ID만 투영**한다. ID 순서·결과 수를 검증했으며, 본문 반환까지 포함한 목록 지연을 측정한 것이 아니다. 모든 실행에서 앱 복호화 호출은 0이다.',
'- 실행한 연산은 contains의 count·ID 목록이다. B 비교 저장물은 접두·접미·전체 일치 도장도 포함하지만 개선 B의 해당 SQL은 이번에 구현·측정하지 않았으므로 전체 연산의 기능 동등성 비교는 아니다.',
'- 넓은 10글자 count는 평문 SQL 약2배 목표에 미달했다. 아래 배수에서 한글 LIKE는 C 로캘 제약으로 운영 성능 판정에 쓰지 않는다.',
'- 실제 500·1,000자 메모의 DB 적재·조회는 측정 안 함. 아래 긴 값의 위치 시도 수는 계산·추정이며 시간 외삽이 아니다. 창 길이3·8, 관리형 부분 수정·삭제·동시 쓰기, 공개 API 통합은 이 담당에서 측정 안 함.',
'- 64비트 해시 충돌이 없는 경우의 문자열 논리와 이번 실측 정확성을 구분한다. 유한 폭 해시를 사용하므로 무조건적인 수학적 오탐0·보안 동등성은 입증하지 않았다. 복원 공격 비율은 이 DB 실험에서 측정 안 함.',
'- 초기 실행에서 SQL 파라미터 바인딩 오류2건을 수정했다(후보 수 전용 SQL의 여분 인자, 용량 조회 배열 인자). 수정 뒤 전체 비교를 완료했고 원 오류 기록도 남겼다; w4 적재 데이터는 그대로 두고 용량·질의 정의 기록만 다시 읽었다.','',
'## 구현·비교 조건','',
'| 항목 | 실제 조건 |','|---|---|',
'| 데이터 | research_u의 기존 고객 100,000행에서 메모·주소만 파생, scope 1개 |',
'| 평문 | 새 pb_astra_plain: ID·scope·정규화 메모·주소, PK 및 두 필드 각각 B-tree·trigram GIN |',
'| B | 새 pb_astra_b: 기존 B의 같은 두 필드 후보·salt·부분/접두/접미/전체 도장만 복제; PK·두 필드 후보 GIN |',
'| 개선 B | 새 pb_astra_w2 / pb_astra_w4: 동일 후보 배열, 필드별 salt16B·글자 수·위치 도장 bigint 배열; PK·동일 후보 GIN |',
'| 창 길이2 | 모든 위치의 2글자 창 하나; 길이2 이상 검색을 이어 붙임 |',
'| 창 길이4 | 모든 위치의 4글자 창 + 짧은 검색 지원용 2·3글자 위치 도장도 저장 |',
'| 위치 표현 | 0부터 센 Unicode 코드포인트 위치를 4바이트 big-endian 정수로 직렬화 |',
'| 도장 | 조각키=HMAC-SHA256(고정 연구키,scope/표/필드/창종류/정규화조각); SHA256(조각키32B∥salt16B∥위치4B) 앞8B |',
'| 배열 배치 | signed bigint 값순 정렬; 배열 순번과 글자 위치를 연결하지 않음 |',
'| SQL | 실제 제품 후보 토큰으로 축소 → 가능한 시작 위치마다 EXISTS 검사; SQL count 또는 ORDER BY id LIMIT300 |',
'| 길이 L 질의 | 창 간격 w, 끝까지 덮기 위한 마지막 창 추가; 같은 시작 p에서 모든 오프셋 도장이 일치해야 함 |',
'| 키·범위 | 기존 연구용 고정키, 동일 100,000행 scope; 정규화 legacy-text-v1 |',
'| DB 안전 | assertDisposable + port56439 확인, measure.lock; 기존 표는 읽기만, 새 pb_* 네 표 보존 |','',
'충돌이 없다면 각 위치 도장 일치는 그 절대 위치의 창 문자열 일치를 뜻한다. 질의 창들이 모든 글자 위치를 덮고 같은 시작 p의 오프셋을 강제하므로, 모두 일치하면 길이 L의 전체 문자열이 일치한다. 반대로 실제 부분 문자열이면 그 시작 p에서 모든 창이 일치한다. L=2도 처리되며, w=4의 L=2·3은 별도 폭의 도장을 사용한다.','',
'## 용량·적재 — 평문=1배','',
'MB=1,000,000바이트. 암호문 본문은 새로 작성하지 않았다. **B와 개선 B의 표는 검색 보조 저장량만**이며 아래 배수는 같은 두 필드 평문 표에 대한 검색 보조 비용이다; 암호문 본문을 포함한 전체 암호화 DB 배수가 아니다. 본문/검색 칸의 total−indexes는 TOAST 부속 공간을 포함한다.','',
'| 표·방식 | 행 수 | 본문 또는 검색 보조 MB(일반 색인 제외) | 일반 색인 MB | 합계 MB | 바이트/행 | 평문 대비 |',
'|---|---:|---:|---:|---:|---:|---:|'];
for(const [name,r] of [['평문 2필드',plain],['B 2필드 검색 보조',b],['개선 B 창2 검색 보조',p2],['개선 B 창4+짧은 창 검색 보조',p4]] as const)lines.push(`| ${name} | 100,000 | ${f((+r.total-r.indexes)/1e6)} | ${f(r.indexes/1e6)} | ${f(r.total/1e6)} | ${f(r.total/100000)} | ${f(r.total/plain.total)}배 |`);
lines.push('',`같은 두 필드 B 검색 보조 대비 개선 B의 물리 저장량 감소는 창2 ${f(100*(1-p2.total/b.total))}%, 창4 ${f(100*(1-p4.total/b.total))}%다. B 비교 표의 두 필드 도장 수는 ${n(+loads[0].previousB.stamps)}개이고, 개선 B는 창2 ${n(+loads[0].logical.positional_stamps)}개 / 창4 ${n(+loads[1].logical.positional_stamps)}개다. 같은 행의 반복 조각도 위치가 다르면 별도 도장이다.`,'',
'| 적재 | 고객 행 | 파생 도장 계산+INSERT 초 | GIN 생성+ANALYZE 초 | 메모/주소 평균 글자 수 |',
'|---|---:|---:|---:|---|');
for(const r of loads)lines.push(`| 창${r.w} | ${n(r.rows)} | ${f(r.loadMs/1000)} | ${f(r.indexMs/1000)} | ${f(r.logical.memo_chars)} / ${f(r.logical.address_chars)} |`);
lines.push('','적재 시간은 각 창 길이당 한 번의 일괄 실행이며 행별 COMMIT 쓰기 중앙값이 아니다. 용량 표는 마지막 같은 시점의 카탈로그 값을 썼다; 초기 평문 용량과 32KiB 차이는 부속 공간 변화이며 행·색인은 바꾸지 않았다.','',
'## 긴 질의: count와 ID 목록300','',
'시간은 ms, SQL 요청~응답과 전체 시간을 분리했다. 한 호출은 SQL1회, 앱 수신 행 수는 count이면 숫자1행·목록이면 반환 ID 수, 앱 복호화0회다. 대상은 모든 행에서 고객100,000이며 목록 정렬은 id 오름차순이다. 조건 4개는 실제 값의 두 번째 글자부터 추출한 10글자 부분 문자열로 빈도가 다른 것을 골랐다. 45글자 조건은 별도 반복 반례다.','',
'| 창 | 조회 | 조건 전문 | 실제 일치 | DB 토큰 후보 | 반환 행 | 평문 SQL/전체 | 개선 B SQL/전체 | 평문 대비 SQL/전체 |',
'|---|---|---|---:|---:|---:|---|---|---|');
for(let i=0;i<2;i++)for(const r of runs[i])lines.push(`| ${loads[i].w} | ${r.mode==='list'?'ID 목록300':'count'} | ${r.field} contains "${r.term}"${/[가-힣]/.test(r.term)?' (한글 LIKE 제약)':''} | ${n(r.truth)} | ${n(r.candidates)} | ${r.resultRows} | ${f(r.medians.plain.dbMs)}/${f(r.medians.plain.totalMs)} | ${f(r.medians.position.dbMs)}/${f(r.medians.position.totalMs)} | ${f(r.ratio.sql)}/${f(r.ratio.total)}배 |`);
lines.push('','## 창4의 짧은 검색 확인','', '| 창 | 조건 | 조회 | 실제 일치 | 결과 행 | 평문 SQL ms | 개선 B SQL ms | 평문 대비 |','|---|---|---|---:|---:|---:|---:|---:|');
for(const r of short)lines.push(`| 4(폭${r.length} 보조 도장) | memo contains "${r.term}" | ${r.mode} | ${n(r.truth)} | ${r.resultRows} | ${f(r.medians.plain.dbMs)} | ${f(r.medians.position.dbMs)} | ${f(r.ratio.sql)}배 |`);
lines.push('','## 후보 행당 위치 시도 비용','',
'EXPLAIN ANALYZE는 성능 반복과 별도로 수집했다. generate_series 노드의 실제 출력+필터 탈락은 한 후보에서 검사한 시작 위치 수이며 PostgreSQL이 반복당 평균으로 표시한다. 다음 비용은 측정 SQL 중앙값을 후보 수로 나눈 **계산값**으로, SQL 왕복·색인·배열 접근 비용을 포함한다; 해시 한 번의 원가가 아니다.','',
'| 창 | 조건 | 후보 행 | 위치 검사 평균/후보 | 질의 창 수 | SQL µs/후보(계산값) |','|---|---|---:|---:|---:|---:|');
for(let i=0;i<2;i++)for(const r of plans[i].filter((r:any)=>r.mode==='count')){const nodes:any[]=[];const visit=(x:any)=>{nodes.push(x);for(const p of x.Plans??[])visit(p);};visit(r.plan[0].Plan);const p=nodes.find(x=>x['Node Type']==='Function Scan');const measured=runs[i].find((x:any)=>x.name===r.name&&x.mode==='count');lines.push(`| ${loads[i].w} | ${r.name} | ${r.candidates} | ${p['Actual Rows']+(p['Rows Removed by Filter']??0)} | ${r.windows} | ${f(measured.medians.position.dbMs*1000/r.candidates)} |`);}
lines.push('','- 실제 10글자 정답 사례는 후보당 시작 위치 2개(0 탈락, 1 일치)를 확인했다. 45글자는 후보2,440행에서 평균7개 시작 위치를 검사해 모두 탈락했다. 단순히 길이만 검사해서 0건이 된 사례가 아니다.',
'- 목록의 흔한 조건은 위치 판정 노드가 300번만 실행되어 정답300개에서 멈췄다. 그러나 앞단은 메모9,944행·주소16,821행의 후보를 정렬했다. 창4의 이 정렬은 external merge였고 창2는 quicksort였다. 제한 목록의 비용은 위치 해시만으로 설명할 수 없다.',
'- 창4는 10글자 count의 창 수를5→3으로 줄였지만 도장 배열이 커졌다. 45글자에서는 창 수23→12에도 창4가 더 느렸으므로 창 개수만으로 속도를 예측할 수 없다.','',
'| 값 길이(가정) | 10글자 질의 최대 시작 위치 | 창2 최대 해시 호출/후보 | 창4 최대 해시 호출/후보 | 창2 / 창4 도장 배열 원소 수 |','|---|---:|---:|---:|---:|');
for(const len of [500,1000])lines.push(`| ${len}자 (추정) | ${len-9} | ${(len-9)*5} | ${(len-9)*3} | ${len-1} / ${3*len-6} |`);
lines.push('','위 표는 모든 시작 위치를 소진할 때의 호출 수 상한이다. EXISTS와 AND 단락 평가로 실제 호출은 줄 수 있다. 현재 ANY(bigint[])는 배열 비교 비용도 있으므로 1,000자 실행 시간을 위 수치에서 선형 외삽할 수 없다. 같은 저장 정보로 위치 탐색·배열 탐색을 더 줄이는 구현은 검증하지 않았다.','',
'## 드러나는 정보와 가설 판정','',
'질의 기록의 조각키 k와 백업의 salt를 함께 가진 관찰자는 가능한 p를 열거해 해당 조각의 위치를 판정할 수 있다. 배열을 값순으로 정렬해도 이 열거가 사라지지 않는다. k가 어떤 문자 조각인지 이름을 붙이는 시작 단서와, 그 뒤 위치를 맞춰 연결하는 전파는 별개다. 이번 DB 실험은 이 신호의 존재를 보여주는 연산 구조를 사용했으며 복원율이나 안전 여부를 측정하지 않았다. 위치 도장 개수와 명시적인 n은 정확한 코드포인트 길이를 드러낸다. 기존 B와 보안이 같다는 결론이나 채택 제안은 하지 않는다.','',
'| 가설 | 근거 | 판정 |','|---|---|---|',
'| 위치를 강제하면 8글자 초과 조건을 DB에서 판정 가능 | 두 창 길이의10·45글자 count/목록20개 비교 모두 일치 | 이번 데이터·질의에서 확인; 충돌 없음 조건의 문자열 논리 증명 |',
`| 저장량 완화 | 같은 두 필드 B ${f(b.total/1e6)}MB → 창2 ${f(p2.total/1e6)}MB / 창4 ${f(p4.total/1e6)}MB | 검색 보조 물리 용량 감소 확인 |`,
'| 긴 검색을 지원하면서 짧은 검색도 유지 | 창4의2·3글자 count/목록4개 비교 일치 | 해당 사례 확인 |',
'| 위치 탐색 비용이 작은가 | 후보당2회/7회에서도 흔한 count가 평문보다 크게 느림 | 약2배 목표 미달; 긴 본문 비용 미검증 |',
'| 기존 B와 드러나는 정보가 같은가 | 질의된 조각의 행뿐 아니라 절대 위치를 열거 가능 | 동일하다고 할 수 없음; 복원 공격 수치는 별도 담당 |','',
'근거: bench/research-task1/pb-astra.ts, pb-astra-report.ts 및 bench/results/2026-09-29-task1/pb-astra*.json. 기존 제품 상태·위협 경계는 docs/current-state.md, docs/threat-model.md, docs/attack-simulation.md를 따른다. 기존 표 변경·커밋 없음. 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.','',
'결론 1. 개선 B는 같은 시작 위치를 강제하여 이번10·45글자 검색을 DB 안에서 맞췄고, ID 목록300도 정답에서 멈췄다.  ',
`결론 2. 검색 보조 저장량은 B 대비 창2 ${f(100*(1-p2.total/b.total))}%·창4 ${f(100*(1-p4.total/b.total))}% 줄었지만, 실제 count·목록 SQL의 평문 약2배 목표를 달성하지 못했다.  `,
'결론 3. 질의 기록과 백업을 함께 얻으면 위치를 열거할 수 있다는 추가 노출이 남으며, 이번 성능·정확성 결과를 보안 동등성의 근거로 삼을 수 없다.','');
writeFileSync('.local/research/task1-m1-astra.md',lines.join('\n'));
writeFileSync(`${root}/pb-astra-audit.json`,JSON.stringify({databaseAccess:false,normalComparisons:20,shortComparisons:4,repetitions:7,warmups:2,firstSeparate:true,allSavedRunsComplete:true,queryDefinitionsEqual:true,at:new Date().toISOString()},null,2)+'\n');
console.log('Report and offline audit saved; 24 comparisons complete.');
