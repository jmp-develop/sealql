import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
const dir='bench/results/2026-09-29-final-return';
const read=n=>JSON.parse(readFileSync(`${dir}/${n}.json`,'utf8'));
const m=read('measure'),w=existsSync(`${dir}/writes.json`)?read('writes'):null,c=existsSync(`${dir}/capacity.json`)?read('capacity'):null,v=read('variant-setup');
const finalMode=(m.variants?.length??0)===0;
const n=x=>Number(x).toFixed(2),ratio=(x,y)=>n(x/y)+'×',mb=x=>n(x/1048576),esc=x=>String(x).replaceAll('|','\\|').replaceAll('\n',' ');
const verdict=(product,research)=>product<=research*1.1?'통과':product-research<=1?'차이 ≤1ms':'미달';
const lines=[];const put=(...s)=>lines.push(...s),table=(head,rows)=>{put('| '+head.join(' | ')+' |','| '+head.map(()=>'---').join(' | ')+' |',...rows.map(r=>'| '+r.map(esc).join(' | ')+' |'),'');};
put('# compact-only 최종안 비교 측정','',`측정 제품 커밋: \`${m.commit}\`. 조회 ${m.rows.length}/113개, 조회 완료 ${m.complete}, 쓰기 완료 ${w?.complete??false}, 용량 완료 ${c?.complete??false}.`,'');
const products=m.rows.map(r=>r.summary.product);
put(`제품은 연구 최종안 대비 SQL 기준 ${products.filter(p=>!p.sqlPass).length}개, 전체 시간 기준 ${products.filter(p=>!p.totalPass).length}개가 1.10배/차이 1ms 허용선을 넘었다. SQL 1초 초과 ${products.filter(p=>p.sqlMs>1000).length}개, 전체 1초 초과 ${products.filter(p=>p.totalMs>1000).length}개다. ${m.complete?(products.some(p=>!p.sqlPass||!p.totalPass||p.overOneSecond)?'정확성 검증은 통과했으나 성능 목표는 미달이다.':'정확성과 성능 목표를 통과했다.'):'진행 중 수치이며 최종 판정이 아니다.'}`,'');
table(['종류','완료','SQL 미달','전체 미달','SQL >1초','전체 >1초'],['count','list300','listAll'].map(mode=>{const s=m.rows.filter(r=>r.mode===mode).map(r=>r.summary.product);return [mode,s.length,s.filter(p=>!p.sqlPass).length,s.filter(p=>!p.totalPass).length,s.filter(p=>p.sqlMs>1000).length,s.filter(p=>p.totalMs>1000).length];}));
put('## 조건과 검증','',
'원본 fixture 100000행의 `*_plain`을 공개 `sealed.insert`로 새 제품 스키마에 적재했다. 공백·대소문자를 보존하며 회사명 exact bits=2, 나머지 기본값, substring=true, wordBoundary 없음이다. 연구 기준선은 task4의 평문 정규화·색인·`pb_4_final` 도장/후보 형식을 재구축했다. 보호 표는 읽기만 했다.',
'',`동일 PostgreSQL 연결(pid ${m.session?.pid}), 예열 2회 후 순서를 회전한 7회 중앙값이다. 첫 호출은 별도로 보존했고 OS 캐시는 비우지 않았다. 모든 실행에서 독립 원문 정규화 oracle과 count 또는 정렬 ID·6필드를 비교했다. SQL 요청~응답은 클라이언트 왕복 합계이며 서버 시간만이 아니다. pre/between/post/total은 벽시계 구간이고 지표별 중앙값은 합산되지 않을 수 있다.`,
'','task4 52조건의 count·목록300, 전체목록 3개, LIKE 3조건의 count·목록300으로 113개다. LIKE 기준선은 역사적 startsWith/endsWith/contains와 정확히 동치인 패턴만 썼다. 모든 literal은 2글자 이상이다. 원래 조건의 respectWords 표시는 task4와 같이 적용하지 않았다.',
'','연구 후보 생성은 당시 word/skip 토큰 형식을 독립적으로 고정했으며 1200필드 native 후보 확인, 198개 동기/WebCrypto 벡터 일치, 기준선 52조건 검증을 통과했다. 연구 목록은 기존 암호 본문을 사용한다. 연구 쓰기는 당시 정규화 평문 암호화를 유지하고 제품 쓰기는 원문 왕복까지 확인한다.',
'','DB 내부 후보 수는 계측하지 않았다. 아래 DB 반환 행은 드라이버가 받은 행이며 내부 후보 수와 다르다. count의 DB 반환은 1행, 인증 복호화는 0회다. 목록은 선택한 6필드의 실제 Sealer.open 호출을 계측했다. C 로캘 한글 LIKE는 평문 전체 스캔 영향을 받아 †로 표시하며 평문 대비 성능 주장에 쓰지 않는다. 배율은 연구 최종안 대비다.','');
put(finalMode?`최종 실행은 변형 없는 3경로만 측정했다. 제품 원문 적재는 ${m.dataCommit}, 조회 함수는 보고서 맨 위 최종 커밋으로 재설치하고 ANALYZE했다. 이전 변형 부분 측정은 [별도 보고](report-variants-partial-ko.md)에 보존했다. 인터셉터의 rowMode와 별도 values 인자 보존 회귀 시험 1/1이 통과했다.`:'제품 소스는 527d13f이며 변형 모듈은 보안 보완을 포함한 4b58f47이다. 두 커밋 사이 src 차이가 없음을 확인했다. [provenance.json](provenance.json)에 파일 해시를 보존한다. 첫 두 프로세스는 벤치 인터셉터의 별도 values 인자 처리 오류로 첫 조건 완료 전에 중단됐다. 실패 파일은 measure-prior-*로 보존하고, 수집·교체 양쪽을 수정한 새 프로세스의 결과만 사용했다. rowMode와 별도 인자 보존 회귀 시험 1/1이 통과했다.','');
put('## 조회 SQL 요청~응답','', '단위 ms, 배율=제품/연구. 근거: [measure.json](measure.json), [cases.json](cases.json).','');
table(['조건','종류','일치/반환','평문','연구 최종안','새 제품','배율','판정'],m.rows.map(r=>{const s=r.summary;return [r.name+(r.cLocaleKoreanLike?' †':''),r.mode,`${r.matches}/${r.returned}`,n(s.plain.sqlMs),n(s.research.sqlMs),n(s.product.sqlMs),ratio(s.product.sqlMs,s.research.sqlMs),verdict(s.product.sqlMs,s.research.sqlMs)];}));
put('## 조회 전체 시간','', '단위 ms. 근거: [measure.json](measure.json).','');
table(['조건','종류','평문','연구 최종안','새 제품','배율','판정'],m.rows.map(r=>{const s=r.summary;return [r.name,r.mode,n(s.plain.totalMs),n(s.research.totalMs),n(s.product.totalMs),ratio(s.product.totalMs,s.research.totalMs),verdict(s.product.totalMs,s.research.totalMs)];}));
put('## 제품 호출 분해와 첫 측정','', '단위 ms. 최초 값은 cold cache 주장이 아니다. 후보 수는 미계측. 근거: [measure.json](measure.json).','');
table(['조건/종류','첫 SQL/전체','pre','between','post','SQL 횟수','DB 반환/결과 행','인증 복호화'],m.rows.map(r=>{const p=r.summary.product,f=r.first.product;return [`${r.name}/${r.mode}`,`${n(f.sqlMs)}/${n(f.totalMs)}`,n(p.preMs),n(p.betweenMs),n(p.postMs),p.sqlCalls,`${p.appRows}/${r.returned}`,p.opens];}));
if(!finalMode){
put('## SQL 변형 비교','', '각 셀은 SQL/전체 ms. 모두 같은 공개 API 준비·투영·복호화 경로에서 SQL만 교체했다. 4a/4d의 변형 컴파일은 SQL 측정 밖이며 원래 공개 API 준비 비용은 전체 시간에 남는다. 4a는 부모 조건 없는 count 전용, 4d는 한정 목록의 fallback 전용이다. 4b checks-off와 qualified-no-set은 별개이며 합친 결과로 해석하지 않는다. 최신 qualified-no-set은 함수·연산자·자기 스키마 호출을 한정하고 새 프로세스에서 재설치했다. 제품 미채택 실험이다.','');
const names=m.variants?.map(v=>v.name)??[];
table(['변형','조건 수','제품 대비 SQL 개선','제품 대비 SQL 악화','연구 대비 SQL 미달','SQL >1초','전체 >1초'],names.map(path=>{const rows=m.rows.filter(r=>r.summary[path]);return [path,rows.length,rows.filter(r=>r.summary[path].sqlMs<r.summary.product.sqlMs/1.1&&r.summary.product.sqlMs-r.summary[path].sqlMs>1).length,rows.filter(r=>r.summary[path].sqlMs>r.summary.product.sqlMs*1.1&&r.summary[path].sqlMs-r.summary.product.sqlMs>1).length,rows.filter(r=>!r.summary[path].sqlPass).length,rows.filter(r=>r.summary[path].sqlMs>1000).length,rows.filter(r=>r.summary[path].totalMs>1000).length];}));
put('개선/악화는 제품 대비 10% 및 절대 1ms를 모두 넘는 차이의 개수다. 이 집계는 조건별 표를 대신하는 평균 성능이나 채택 권고가 아니다.','');
for(const mode of ['count','list300','listAll']){const rows=m.rows.filter(r=>r.mode===mode),paths=names.filter(p=>rows.some(r=>r.summary[p]));put(`### ${mode}`,'');table(['조건','제품',...paths.map(p=>p.replace('v4','4'))],rows.map(r=>[r.name,`${n(r.summary.product.sqlMs)}/${n(r.summary.product.totalMs)}`,...paths.map(p=>r.summary[p]?`${n(r.summary[p].sqlMs)}/${n(r.summary[p].totalMs)}`:'—')]));}
put('4c는 같은 100000행을 ID순으로 새 복제하고 배열을 재물질화한 뒤 저장 방식을 적용했다. MAIN/EXTENDED와 꼬리 색인은 네 복제본끼리 비교해야 한다. 동시 배치로 적재한 원본 제품 표와의 차이는 물리 행 순서 효과도 포함한다. 부모 본문은 동일하다. 근거: [variant-setup.json](variant-setup.json).','');
table(['복제본','저장','꼬리 색인','heap MiB','색인 MiB','전체 MiB','전체 값 일치'],v.clones.map(x=>[x.schema,x.storage,x.cover,mb(x.sizes.heap),mb(x.sizes.indexes),mb(x.sizes.total),x.allValuesEqual]));
}
put('## 미달 조건과 EXPLAIN','', '미달은 연구 대비 >1.10배이면서 절대 차이 >1ms인 경우다. SQL 또는 전체 >1초도 별도 표시한다. EXPLAIN은 모든 교차 측정 후 별도 1회이며 중앙값이 아니다. '+(existsSync(`${dir}/plans.json`)?'근거: [plans.json](plans.json).':'EXPLAIN 미실행: 코디네이터 요청으로 부분 측정에서 중단했다.'),'');
const plans=existsSync(`${dir}/plans.json`)?read('plans'):[];
function walk(p,out=[]){out.push(p);for(const child of p.Plans??[])walk(child,out);return out;}
table(['조건/종류','SQL 배율','전체 배율','1초 초과','EXPLAIN 관찰'],m.rows.filter(r=>!r.summary.product.sqlPass||!r.summary.product.totalPass||r.summary.product.overOneSecond).map(r=>{const s=r.summary.product,plan=plans.find(p=>p.name===r.name&&p.mode===r.mode&&p.path==='product'),roots=plan?.plans.flatMap(p=>p.plan.map(p=>p.Plan))??[],nodes=roots.flatMap(p=>walk(p)),expensive=[...nodes].sort((a,b)=>(b['Actual Total Time']??0)*(b['Actual Loops']??1)-(a['Actual Total Time']??0)*(a['Actual Loops']??1)).slice(0,3).map(x=>`${x['Node Type']} ${n(x['Actual Total Time'])}ms×${x['Actual Loops']} (${x['Actual Rows']}행)`).join('; ');return [`${r.name}/${r.mode}`,n(s.sqlRatio),n(s.totalRatio),[s.sqlMs>1000?'SQL':'',s.totalMs>1000?'전체':''].filter(Boolean).join('/')||'없음',expensive||'대기'];}));
put('노드 시간은 부모에 자식 시간이 포함되므로 더하지 않는다. EXPLAIN이 있는 경우의 관찰은 실행 계획 근거이며 특정 검사의 인과적 비용을 단독으로 입증하지 않는다.','');
if(finalMode&&m.complete){
put('### 남은 비용의 관찰','', '다음 값은 7회 중앙값과 분리한 EXPLAIN 1회에서 읽었다. 원인 분해가 완료된 성능 보장으로 해석하지 않는다.','');
table(['조건','실행 계획 근거','해석'],[
 ['LIKE suffix count','Parallel Seq Scan, 합계 100000행; EXPLAIN 전체 1287.22ms, shared hit 16629/read 17653 blocks','전체 행 LIKE 판정 경로가 남았다. SQL 중앙값 1233.05ms이며 함수 자체와 I/O 비용은 이 계획만으로 분리할 수 없다.'],
 ['and2 목록300','quick 264행 + fallback 36행. fallback 후보 28166행(추정1227), external merge 11576kB, fallback 117.04ms','앞부분 결과 재사용은 동작하지만 남은 36행을 얻기 위한 후보 읽기·정렬 비용이 크다.'],
 ['and3_or_rare 목록300','quick 50행 + fallback 250행. 후보4808행(추정203), 정렬3768kB, fallback31.54ms','이어찾기 후에도 후보 수 과소추정과 전체 후보 정렬이 관찰된다.'],
 ['sub_mid count / 목록','count Bitmap Index 실제16574행/추정25행. 목록 fallback 후보16376행/추정8행, external merge5912kB','후보 선택도 추정과 실제 행 수가 크게 다르다. 판정 함수만의 비용으로 설명할 수 없다.'],
 ['exact_zero 목록300','sample1200행을 모두 읽고 quick에서1200행 제거(1.48ms); fallback Index Only Scan은0행','결과0건에도 앞부분 탐색이 실행돼 작은 조회의 고정 비용이 남는다.'],
 ['exact_common 전체목록','28331행, 인증 복호화169986필드. SQL 중앙값161.45ms, 전체5820.44ms','전체 시간의1초 초과는 SQL 이외 작업이 대부분이며 count의1초 초과와 구분한다.'],
]);
}
put('## 쓰기','', '독립 insert300 / memo update100 / delete100, 행마다 commit. 리셋·정답 확인은 시간 밖. 7회 배치 합계 중앙값/행과 배치 내 행 중앙값의 중앙값을 분리한다. 근거: [writes.json](writes.json).','');
if(w)table(['작업','경로','SQL ms/행','전체 ms/행','행 중앙값 ms','배치 전체 ms','SQL 횟수/행'],w.cases.flatMap(r=>['plain','research','product'].map(p=>{const s=r.summary[p];return [r.op,p,n(s.sqlMs/r.rows),n(s.totalMs/r.rows),n(s.medianRowMs),n(s.totalMs),n(s.sqlCalls/r.rows)];})));
put('## 용량','', 'MiB=2^20 bytes. 연구 경로에는 공유 native 암호 본문 전체 크기를 포함한다. 근거: [capacity.json](capacity.json).','');
if(c){table(['경로','전체 MiB','bytes/행','평문 대비'],Object.entries(c.totals).map(([p,s])=>[p,mb(s),n(s/100000),ratio(s,c.totals.plain)]));table(['관계','heap MiB','TOAST heap MiB','TOAST index MiB','표 index MiB','보조 MiB','전체 MiB'],c.tables.map(t=>[t.relation,mb(t.heap),mb(t.toast_heap),mb(t.toast_indexes),mb(t.indexBytes),mb(t.heap_aux+t.toast_aux),mb(t.total)]));}
put('로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다. 커밋하지 않았다.','');
put('## 조건 정의','', '근거: [cases.json](cases.json).','');
table(['조건명','식'],[...new Map(m.rows.map(r=>[r.name,r])).values()].map(r=>[r.name,r.condition]));
writeFileSync(`${dir}/report-ko.md`,lines.join('\n'));
if(m.complete&&w?.complete&&c?.complete){assert.equal(m.rows.length,113);assert.deepEqual(m.errors,[]);assert.deepEqual(w.errors,[]);assert.equal(w.commit,m.commit);assert.equal(c.commit,m.commit);if(finalMode){assert.deepEqual(m.variants,[]);assert(m.functionInstall.some(sql=>/cost\s+1900/i.test(sql)),'Final predicate function COST1900 must be installed');}for(const r of m.rows){if(finalMode)assert.deepEqual(r.paths,['plain','research','product']);for(const p of r.paths){assert.equal(r.runs[p].length,7);assert(r.first[p]);for(const run of r.runs[p]){for(const value of Object.values(run))assert(Number.isFinite(value)&&value>=0);assert.equal(run.opens,p==='plain'||r.mode==='count'?0:r.returned*6);}}}assert.equal(w.cases.length,3);for(const r of w.cases)for(const p of ['plain','research','product'])assert.equal(r.runs[p].length,7);for(const t of c.tables){assert.equal(t.rows,100000);assert.equal(t.total,t.heap+t.heap_aux+t.toast_heap+t.toast_aux+t.toast_indexes+t.indexBytes);}writeFileSync(`${dir}/artifact-check.json`,JSON.stringify({at:new Date().toISOString(),passed:true,jobs:113,writeOperations:3,commit:m.commit,finalFunctionCost1900:finalMode},null,2)+'\n');}
console.log(JSON.stringify({queryComplete:m.complete,rows:m.rows.length,writesComplete:w?.complete??false,capacityComplete:c?.complete??false,report:`${dir}/report-ko.md`}));
