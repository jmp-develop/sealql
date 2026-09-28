import assert from 'node:assert/strict';
import {readFileSync,existsSync,appendFileSync} from 'node:fs';
const dir='bench/results/2026-09-28-mission/';
const a=JSON.parse(readFileSync(dir+'m1-astra-attack.json','utf8')),b=JSON.parse(readFileSync(dir+'m1-astra-db.json','utf8'));
assert.equal(a.datasets.length,2);assert.equal(b.cases.length,4);
let lines='\n## 8. 최종 재현 확인\n\n마지막 실행에서 같은 비교 단위(모르는 행의 서로 다른 인접 bigram)로 지표를 맞추었다. 전체 문자열 복원은 위치 대조군에서만 위치별 문자를 이어 검증했다.\n\n| 자료 | 알려진 원문 | 현재 인접조각 복원 | A 인접조각 복원 | 위치 인접조각 복원 | 위치 80%행 | 위치 완전문자열 |\n|---|---:|---:|---:|---:|---:|---:|\n';
for(const d of a.datasets){if(d!==a.datasets[0])lines+='| 자료 | 알려진 원문 | 현재 인접조각 복원 | A 인접조각 복원 | 위치 인접조각 복원 | 위치 80%행 | 위치 완전문자열 |\n|---|---:|---:|---:|---:|---:|---:|\n';for(let i=0;i<3;i++){const c=d.current.known[i],s=d.allSubstring.known[i],p=d.positional.known[i];lines+=`| ${d.dataset} | ${c.knownPct}% | ${c.adjacentPct}% | ${s.adjacentPct}% | ${p.adjacentPct}% | ${p.unknownAdjacent80Pct}% | ${p.fullNormalizedValuePct}% |\n`;}
 let fp=0;for(const q of d.correctness){assert.equal(q.truth,q.positional);assert.equal(q.truth,q.allSubstring);assert.equal(q.truth,q.rowBound);assert(q.currentCandidates>=q.truth);fp+=q.currentFalsePositives;}
 lines+=`\n${d.dataset}: ${d.correctness.length}개 서로 다른 질의에서 A/B/위치 후보 count는 모두 평문과 일치했다. 현재 토큰의 후보 관계 오탐 합은 ${fp}개이며 제품은 인증 재확인으로 제거한다. 이것은 앞 절의 참고자료 상위128개 질의 실험과 다른 질의 묶음이다.\n\n`;
}
for(const c of b.cases)for(const [name,runs] of Object.entries(c.runs) as [string,any[]][]){assert.equal(runs.length,7);for(const r of runs)assert.equal(r.count,c.expected);assert.equal(c.summary[name].sqlCalls,1);}
assert.equal(b.integrity.afterForgedTag,b.integrity.before+1);
if(existsSync('.local/research/measure.lock'))assert(!readFileSync('.local/research/measure.lock','utf8').includes('m1-astra'),'Own measurement lock remains');
lines+='\nDB 4질의 × 4경로 × 측정7회 = 112회 count 동등성 단언 통과(별도 사전확인·예열 제외). 자기 실험 스키마 잔존 0개, 원본 고객 100,000행 유지, 자기 측정 락 해제를 확인했다. 최종 점검 시 다른 연구자의 측정 락이 생겼으며 건드리지 않았다. 최종 노트 작성 시점에 추가 탐색과 측정은 종료했다.\n';
appendFileSync('.local/research/m1-astra.md',lines);console.log(lines);
