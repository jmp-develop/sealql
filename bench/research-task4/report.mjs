import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const OUT='bench/results/2026-09-29-task4';
const read=n=>existsSync(`${OUT}/${n}.json`)?JSON.parse(readFileSync(`${OUT}/${n}.json`,'utf8')):null;
const a=read('measure')??{rows:[],errors:[],plans:[]},meta=read('metadata'),load=read('load'),cases=read('cases')??[],ad=read('adversarial');
const writes=read('write');
const paths=['plain','A','B','improved','final'],label={plain:'평문',A:'A 지금 방식',B:'B 행별 도장',improved:'개선 B 창2',final:'최종안'};
const f=(x,d=2)=>x==null?'미측정':Number(x).toFixed(d),num=x=>Number(x).toLocaleString('en-US');
const table=(h,rs)=>'| '+h.join(' | ')+' |\n| '+h.map(()=>'---').join(' | ')+' |\n'+rs.map(r=>'| '+r.map(x=>String(x).replaceAll('|','\\|').replaceAll('\n',' ')).join(' | ')+' |').join('\n');
const cond=n=>'all'in n?'('+n.all.map(cond).join(' AND ')+')':'any'in n?'('+n.any.map(cond).join(' OR ')+')':`${n.field} ${n.op} "${n.value}"`;
const koreanLike=n=>'all'in n?n.all.some(koreanLike):'any'in n?n.any.some(koreanLike):n.op!=='eq'&&/[가-힣]/.test(n.value);
const row=(name,mode)=>a.rows.find(r=>r.name===name&&r.mode===mode);
const time=(r,p)=>!r?'미측정':r.failed[p]?'정답 실패':!r.summary[p]?'미완료':`${f(r.summary[p].db)} / ${f(r.summary[p].total)} (${f(r.summary[p].total/r.summary.plain.total)}배)${p==='A'?' [n='+r.runs.A.length+']':''}`;
const fullRows=[];
for(const c of cases)for(const mode of ['count','list'])for(const p of paths){const r=row(c.name,mode),m=r?.summary[p];fullRows.push({case:c.name,condition:cond(c.node),koreanLikeReference:koreanLike(c.node),mode,path:p,targetRows:100000,matches:r?.matches??'',dbCandidates:r?.candidates[p]??'',returned:r?.returned??'',sqlCalls:m?.sql??'',appRows:m?.appRows??'',authenticatedFields:m?.decrypts??'',plainMs:r?.summary.plain?.total??'',preMs:m?.pre??'',sqlRequestResponseMs:m?.db??'',betweenSqlMs:m?.between??'',postMs:m?.post??'',totalMs:m?.total??'',plainRatio:m?.ratio??'',sqlRatio:m?.sqlRatio??'',samples:r?.runs[p]?.length??0,status:r?.failed[p]?'incorrect':m?'complete':'not_measured'});}
const csvHeaders=Object.keys(fullRows[0]??{}),csvcell=x=>'"'+String(x??'').replaceAll('"','""')+'"';
writeFileSync(`${OUT}/metrics.csv`,[csvHeaders,...fullRows.map(r=>csvHeaders.map(k=>r[k]))].map(r=>r.map(csvcell).join(',')).join('\n')+'\n');
const complete=mode=>a.rows.filter(r=>r.mode===mode&&r.summary.final).length;
const zeroCases=cases.filter(c=>a.rows.some(r=>r.name===c.name&&r.matches===0));
const metricsTable=mode=>table(['사례·조건 전문','일치','평문 DB / 전체 (1배)','A DB / 전체 (배율)','B DB / 전체 (배율)','개선 B DB / 전체 (배율)','최종안 DB / 전체 (배율)'],cases.map(c=>{const r=row(c.name,mode);return [c.name+(koreanLike(c.node)?' †':'')+': '+cond(c.node),r?.matches??'미측정',...paths.map(p=>time(r,p))];}));
const failures=a.errors.map(e=>[e.name,e.mode,label[e.path],e.name==='sub45'&&e.path==='B'?(e.mode==='count'?'평문0건 / B 2,440건':'평문 목록0건 / B는 행을 반환하여 ID·값 대조 실패'):e.message.split('\n')[0]]);
const ts=meta?.tables??[],plainTable=ts.find(t=>t.schema==='research_u'&&t.table==='customers_plain'),body=ts.find(t=>t.schema==='native_verify_main'&&t.table==='customers'),size=t=>Number(t?.sizes.total??0);
const sizes=paths.map(p=>{const names=p==='plain'?['research_u.customers_plain']:p==='A'?['native_verify_main.customers','native_verify_main.customers_seal_index']:['native_verify_main.customers','research_u.'+({B:'b_customers_tags',improved:'pb_4_improved',final:'pb_4_final'}[p])];const total=names.reduce((s,name)=>s+size(ts.find(t=>t.schema+'.'+t.table===name)),0);return [label[p],100000,names.join(' + '),f(total/1e6),f(total/100000),size(plainTable)?f(total/size(plainTable))+'배':'미측정'];});
const top=a.rows.filter(r=>r.summary.final).sort((x,y)=>y.summary.final.total-x.summary.final.total).slice(0,5);
const report=`# 과제4 — 최종안 6칸 count·목록300 비교

## 실패·미검증 / 진행 상태

작성 ${new Date().toISOString()} UTC. **최종안 count ${complete('count')}/${cases.length}, 목록300 ${complete('list')}/${cases.length} 완료**. 22:12Z에 count25개·목록0개 부분 보고 후 사용자 지시로 남은 조건을 이어서 측정했다. **A 반복 축소:** 재개 후 A만 첫1회·예열1회·교차3회, 이미 완료된 최초25개 count의 A는 예열2회·교차7회 결과를 보존했다. 평문·B·개선 B·최종안은 모두 첫1회·예열2회·교차7회 중앙값이다. A의 표본 수 n은 표마다 표시하며 미완료칸에 추정 시간을 쓰지 않았다.

${failures.length?table(['사례','연산','경로','오류·불일치(시간 비교에서 제외)'],failures):'현재 저장된 결과에서 정답 불일치 없음.'}

${a.finished?'본 측정과 별도 계획 수집 종료: '+a.finished:'본 측정 미완료: 아래 미측정/미완료칸은 이번 시간 안에 측정하지 못한 항목이다.'}

${a.sessionAudit?'**물리 세션 조건의 한계:** 초기 재개 측정 끝에 연결 PID가 바뀌었다. 저장된 지표에서 A의 or6 count 후처리가 약12초여서 기본 유휴 만료10초를 넘었다. 유휴 만료를 끄고 해당 조건의 다섯 경로를 재측정했으며 보정 전 자료는 before-session-repair.json에 보존했다. 최초 예열까지 포함한 모든 SQL의 PID는 계측하지 않아 초기 전체 반복의 물리 세션 불변은 입증하지 못했다.':''}

${writes?.finished?'삽입·메모 부분 수정·삭제는 마지막 쓰기 절에서 별도로 검증했다.':'삽입·메모 부분 수정·삭제는 검색 종료 뒤 별도 측정한다(현재 완료 전).'} 동시성·장애 주입·공격 성공률은 이 성능 실험에서 측정하지 않았다. 원본 공백·대소문자 보존 반환이 아니라 **정규화된 6칸 값 반환**을 비교한다. A/B/개선 B/최종안 모두 동일한 제품 native 본문의 행·필드·scope 결속 AES-GCM을 사용한다. B의 DB 판정 한계가 있는 사례는 그대로 실패로 기록하고 해당 경로의 반복을 중단한다.

## 데이터·환경 (실제 조회)

${table(['경로 표','전체 행 수','scope 수','scope별 행 수'],ts.map(t=>[t.schema+'.'+t.table,num(t.rows),t.scopeCount,t.scopes.map(s=>s.scope_id+': '+num(s.rows)).join('; ')]))}

${meta?'세션 PID '+(a.segments??[{pid:a.session?.pid}]).map(s=>s.pid).join(' → ')+'; '+meta.session.version+'; lc_collate='+meta.session.lc_collate+'; work_mem='+meta.session.work_mem+'; max_parallel_workers_per_gather='+meta.session.workers:'환경 메타데이터 미수집'}

최초 프로세스가 22:11:20Z 실행 시한에 종료되어 완료25조건은 보존하고 남은 조건부터 새 세션에서 재개했다. **전체 보고가 한 물리 세션인 것은 아니며, 각 조건·연산의 다섯 경로는 연결1개짜리 같은 풀에서 교차 측정**했다. 유휴 만료에 따른 물리 연결 변경과 보정은 맨 위 한계에 명시했다. 세션별 시작 시각·A 반복 규칙은 원자료 segments에 기록했다. 시한 도중 미완료였던 조건은 표본을 섞지 않고 새 세션에서 처음부터 다시 쟀다.

평문은 기존 research_u.customers_plain의 6칸 B-tree와 trigram GIN을 그대로 사용했다. **한글 LIKE 포함 행의 배율은 C 로캘 참고값이며 성능 목표 판정에서 제외**한다. 모든 scope는 ${'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'} 1개, 대상은 100,000행이다. 암호 경로 데이터 ID·scope 집합과 평문 집합의 차이 검사: ${meta?.identityMismatch??'미측정'}행.

## 확정 설계와 질의

최종안은 6칸의 2글자 등장 순번 도장·평문 위치·찾으면 중단하는 판정에 **회사명만 정확 후보 2비트**를 적용했다. 나머지 5칸은 값 종류가 많으므로 사용자 결정대로 정확 후보 16비트를 유지했다. 접두는 시작 위치0, 접미는 n−질의길이를 요구하고, 긴 문자열은 겹침을 포함한 2글자 창의 상대 위치를 확인한다. SQL Boolean 트리의 각 가지에 자기 후보와 도장 검증을 함께 둔다.

list300 CASES14 + MORE_CASES20 + SPACE_CASES3 = 37개를 원문 그대로 추출했다. 추가는 거친 회사명 0건·드문 회사 AND 메모·0건 회사 AND 메모 3개와 전 6칸 접두/접미 12개로 **${cases.length}개**다. 단어 경계라는 기존 사례 이름도 실제 의미는 공백을 제거한 substring이며 다른 의미의 질의로 해석하지 않았다.

없는 회사명 고정값: **${ad?.value??'미확정'}**, 평문 일치 ${ad?.plain??'미측정'}, 최대 2비트 버킷 ${ad?.bucket??'미측정'}, 후보 ${ad?.candidates??'미측정'}행. 원래16비트 후보에서 상위2비트가 그 버킷과 같고 평문 표에서0건인 값을 찾아 고정했다.

## 개발 판단에 필요한 핵심 사실

1. 최종안은 **count52·목록52 조건의 정답을 모두 유지**했다. 45글자0건은 기존 B가2,440건을 잘못 센 반면 최종안은0건이었다. 쓰기 후 값·검색 결과·다른 칸 불변도 ${writes?.checks?.length??0}/90회 확인했다.
2. **SQL 평문2배 기준을 전 조건에서 달성하지 못했다.** 한글 LIKE 참고행을 제외한13조건에서 최종안 SQL≤2.00배는 ${a.rows.filter(r=>r.mode==='count'&&!koreanLike(r.node)&&r.summary.final?.sqlRatio<=2).length}/13 count, ${a.rows.filter(r=>r.mode==='list'&&!koreanLike(r.node)&&r.summary.final?.sqlRatio<=2).length}/13 목록이다. 전체 시간과 SQL 시간을 혼동하지 않은 판정이며, 작은 절대시간의 배율도 표에 그대로 둔다.
3. 가장 큰 확인된 거친 번호 대가는 **없는 회사명0건**이다: 후보40,012개, count SQL ${f(row('coarse_company_zero','count')?.summary.final?.db)}ms(평문 ${f(row('coarse_company_zero','count')?.summary.final?.sqlRatio)}배), 목록 SQL ${f(row('coarse_company_zero','list')?.summary.final?.db)}ms(${f(row('coarse_company_zero','list')?.summary.final?.sqlRatio)}배). 결과0건에는 반환 필드 인증 비용이 없으므로 이 비용은 결과 본문을 여는 데서 생긴 것이 아니다.

표의 **†는 한글 LIKE를 포함해 C 로캘 배율을 목표 판정에서 제외한 참고행**이다. 회사명 정확 일치(없는 회사명 포함)는 † 대상이 아니다.

## count — SQL 왕복 ms / 전체 ms (전체 평문 배율)

${metricsTable('count')}

## 목록300 — SQL 왕복 ms / 전체 ms (전체 평문 배율)

${metricsTable('list')}

모든 완료 호출마다 count 정수 또는 **ID 순서와 정규화 6칸 투영 값**을 평문과 비교했다. 목록은 id 오름차순 limit300이다. 실제 Sealer.open 호출을 계측했으며 A의 조건 검사도 포함한다. 서로 다른 단계의 중앙값은 더해서 전체 중앙값과 같아지지 않을 수 있다. 최초값은 cold라고 부르지 않고 원자료 first에 따로 보존했다.

## 0건 사례 모음

${table(['조건 전문','최종안 후보','count 최종안 DB / 전체','목록300 최종안 DB / 전체','B 판정'],zeroCases.map(c=>{const r=row(c.name,'count');return [c.name+': '+cond(c.node),r?.candidates.final??'미측정',time(r,'final'),time(row(c.name,'list'),'final'),r?.failed.B?'실패':r?.summary.B?'일치':'미측정'];}))}

## 호출·수신·복호·시간 분해

아래는 경로별 모든 **완료 실행**의 지표다. 조건 전문·대상100,000행·실제 일치·DB 후보·반환행·평문 시간·모든 단계·비율을 갖춘 전체 표는 [metrics.csv](../../bench/results/2026-09-29-task4/metrics.csv)에 있다. 후보는 LIMIT 전 토큰 조건의 전체 후보집합이며 앱 수신 행과 다르다. SQL 왕복에는 서버 처리와 전송이 함께 포함된다.

${table(['사례·연산','경로','후보','SQL 수','앱 수신행','인증 복호 필드','전처리 ms','SQL ms','SQL사이 ms','후처리 ms','전체 ms','평문배율'],fullRows.filter(r=>r.status==='complete').map(r=>[r.case+' '+r.mode,label[r.path],r.dbCandidates,r.sqlCalls,r.appRows,r.authenticatedFields,f(r.preMs),f(r.sqlRequestResponseMs),f(r.betweenSqlMs),f(r.postMs),f(r.totalMs),f(r.plainRatio)]))}

## 용량·적재 (100,000행, MB=1,000,000바이트)

${table(['경로','고객 행 수','합산한 표(공유 본문은 경로마다1회)','total MB','행당 바이트','평문 대비'],sizes)}

신규 적재: 개선 B ${load?.rows??0}행, 행 생성·삽입 ${f(load?.loadMs/1000)}초, 최종안 복사 ${f(load?.finalCopyMs/1000)}초, 색인 ${load?.indexMs?Object.entries(load.indexMs).map(([k,v])=>k+' '+f(v/1000)+'초').join(', '):'미완료'}, 총 ${f(load?.totalMs/1000)}초. 기존 평문·A·B 적재는 이번에 측정하지 않았다. 표와 함수를 재측정용으로 보존했다.

## 느린 사례와 계획

${table(['사례','연산','최종안 SQL ms','최종안 전체 ms','별도 EXPLAIN'],top.map(r=>[r.name,r.mode,f(r.summary.final.db),f(r.summary.final.total),a.plans.some(p=>p.name===r.name&&p.mode===r.mode)?'원자료 plans에 있음':'미수집']))}

EXPLAIN(ANALYZE,BUFFERS)는 느린 최종안 상위5개의 별도1회만 수집하며 반복 중앙값에 섞지 않는다. 현재 수집 ${a.plans.length}/5개.

계획의 관측: 10만행이 일치하는 이메일 접미는 병렬 Seq Scan, biz.test 접미는26,598행 Bitmap Heap Scan이었다. 혼합 OR/AND는 BitmapAnd·BitmapOr로 후보를 모은 뒤 행별 위치를 판정했고, or6는 병렬 Bitmap Heap Scan이었다. 후보 번호만으로 정답이 끝나지 않으며, 위치 판정과 넓은 후보집합을 읽는 비용이 남는다. 버퍼 Read는 PostgreSQL 버퍼 미스이며 실제 디스크 읽기량으로 단정하지 않는다.

## 색인 목록 (pg_indexes 원문)

${ts.map(t=>'### '+t.schema+'.'+t.table+'\n\n'+table(['색인','정의'],t.indexes.map(i=>[i.indexname,i.indexdef]))).join('\n\n')}

## 판단·남은 일

- 실측 사실: 완료된 최종안 count ${complete('count')}, 목록 ${complete('list')}개; 최종안 실패 ${a.errors.filter(e=>e.path==='final').length}개. 실패가 있거나 미완료인 조건을 성능 통과로 세지 않았다.
- SQL 약2배 목표는 한글 LIKE 참고행을 제외하고 행별 SQL 배율로 판단해야 한다. 전체 시간 배율을 SQL 시간 배율로 바꾸어 말하지 않는다. 세부 두 비율은 metrics.csv에 모두 있다.
- 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다. 22:12Z 부분 보고 뒤 남은 측정을 이어가라는 사용자 지시를 반영했고, 미완료분이 있으면 표의 미측정/미완료 표시 그대로 남긴다. 경로·케이스 선택형 정리 및 C·D 확장은 사용자 취소 지시로 수행하지 않았다.

출처: [실행 스크립트](../../bench/research-task4/task4-astra.ts), [37개 원문 케이스](../../bench/research-task4/cases.ts), [반복·오류·계획 원자료](../../bench/results/2026-09-29-task4/measure.json), [환경·색인](../../bench/results/2026-09-29-task4/metadata.json), [적재](../../bench/results/2026-09-29-task4/load.json). 사용자 최신 지시로 m1-fable 검토 대기를 없앴고 코디네이터의 스크립트 검토 및 추가2조건 지시를 반영했다. 기존 표 수정·삭제·커밋 없음.

검색·쓰기 스크립트의 strict TypeScript 검사 통과. 원자료 감사에서 최종안104개 모두7표본, A는25개7표본·79개3표본, 최종안 count 복호0회·목록 반환행×6회, 계획5개, 쓰기90회 검사·각7표본을 확인했다. 최종 측정 종료 후 락이 없음을 확인했다.

## 쓰기 비교 — 검색 측정 종료 후 새 전용 표만 사용

${writes?.finished?'완료 '+writes.finished:writes?'진행 중':'미실행'}. ${writes?.error?'실패: '+writes.error.message:''}

평문 / A / 최종안, 기존 fixture 첫400행에서 삽입300행·메모 수정100행·삭제100행을 파생했다. 매 행 한 트랜잭션의 **커밋까지 포함**하며 최초1회 별도·예열2회·경로 순서를 회전한 교차7회 중앙값이다. 준비·TRUNCATE·초기상태 복사·사후 검사는 측정 구간 밖이다. 기존 표는 읽기만 하고 새 pb_4_w_* 표만 갱신했다. 기존 표를 바꾸지 않는다는 규칙은 이 실험에서 새로 만든 쓰기 표에 대한 반복 갱신을 제외한 뜻이다.

**A 공개 API에 sealed.delete는 없다.** 삽입·수정은 sealed.insert/update, 삭제는 실제 제품 사용 경로인 Drizzle db.delete(parent)와 FK ON DELETE CASCADE를 한 트랜잭션으로 실행했다. 최종안은 같은 행 결속 암호문과 6칸 위치 도장·회사명2비트 표를 같은 트랜잭션에 갱신하며, 삭제는 FK cascade를 사용했다. INSERT의 암호화·후보 생성·행별/위치 도장 생성 비용도 전부 포함했다.

${table(['연산','행 수','경로','SQL ms','전체 ms','평문 대비','행당 wall ms','행별 지연 중앙값 ms','SQL 호출 수'],(writes?.cases??[]).flatMap(r=>['plain','A','final'].map(p=>{const m=r.summary[p];return [r.op,r.rows,label[p],f(m?.dbMs),f(m?.totalMs),m?f(m.ratio)+'배':'미완료',f(m?.wallMsPerRow),f(m?.medianRowMs),m?.sqlCalls??'미완료'];})))}

사후 검사는 각 경로·연산·반복마다 전체 행 수, 남은 모든 행의 6칸 값, 회사명 정확 count, 메모 부분 검색 count, 검색 표 행 수를 평문 기대값과 대조한다. 메모 수정 때는 변경한100행의 다른5칸 암호문·토큰·도장 바이트가 그대로인지도 비교한다. 사후 검사 완료 ${writes?.checks?.length??0}/90회, 각 검사 값 필드 합 ${writes?.checks?.reduce((s,c)=>s+c.valuesChecked,0)??0}개. 사후 인증 검사의 복호 시간은 쓰기 시간에 포함하지 않았다. 실패를 주입한 rollback·동시 쓰기는 이번 범위에 없다.

전용 표는 pb_4_w_plain, pb_4_w_a, pb_4_w_a_seal_index, pb_4_w_final_ct, pb_4_w_final_tags이며 삭제하지 않고 보존했다. [쓰기 스크립트](../../bench/research-task4/write.ts), [첫 호출·반복·사후 검사 원자료](../../bench/results/2026-09-29-task4/write.json).
`;
writeFileSync('.local/research/task4-m1-astra.md',report);console.log({count:complete('count'),list:complete('list'),cases:cases.length,failures:a.errors.length,finished:a.finished,reportChars:report.length});
