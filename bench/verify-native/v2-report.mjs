import {readFileSync,writeFileSync} from 'node:fs';
const root='bench/results/2026-09-27-native-verification/v2';
const tokens=JSON.parse(readFileSync(`${root}/tokens.json`,'utf8'));
const attack=JSON.parse(readFileSync(`${root}/attack.json`,'utf8'));
const fmt=x=>Number(x).toFixed(2);
const rows=[];
for(const [name,data] of [['공개 리뷰·메모리',attack.memory],['상수 scope 메모·DB 토큰',attack.db]]){
  rows.push(`| ${name} | 빈도 | ${fmt(data.frequency.allPct)}% | ${fmt(data.frequency.unknown80Pct)}% |`);
  for(const k of data.known){
    rows.push(`| ${name} | 원문 ${k.knownPct}% | ${fmt(k.count.allPct)}% | ${fmt(k.count.unknown80Pct)}% |`);
    rows.push(`| ${name} | 원문 ${k.knownPct}% + 일관성 | ${fmt(k.consistency.allPct)}% | ${fmt(k.consistency.unknown80Pct)}% |`);
  }
}
const shortRows=Object.entries(attack.short).map(([field,v])=>
  `| ${field} | ${v.cipherLengthBuckets} | ${v.distinctValues} | ${v.distinctTokens} | ${v.known.map(k=>k.correct).join(' / ')} |`).join('\n');
const md=`# V2. Drizzle 네이티브 API 토큰·누출 검증

2026-09-27. 일회용 PostgreSQL \`127.0.0.1:56439\`에서 공개 API로 재암호화한 \`native_verify_main\`을 검증했다. 원본 \`bench_realistic_100k\`는 읽기만 했다. 공개 리뷰 \`.local/ratings.txt\`는 메모리에서만 사용하고 DB에 적재하지 않았다. DB 스크립트는 \`assertDisposable\`과 포트 확인 뒤 실행했다. 원시 수치: [tokens.json](tokens.json), [attack.json](attack.json).

## 토큰 동일성

고객 10,000행 × 6개 필드 × exact/substring 2개 프로필의 보조 토큰 배열을, 같은 키·모델·필드·scope로 공개 \`searchPieces\`·\`searchTokens\`에서 재계산했다. **누락 0개, 추가 0개**였다. 별도 상수 scope \`'_'\` 테이블의 메모 40,000행 중 피해 20,000행에서도 같은 재계산 대비 누락 0개, 추가 0개였다. 이 검사는 키를 가진 검증자의 정답 비교이며 공격자에게 토큰 계산 권한을 준 결과가 아니다.

## 기계적 덤프 공격

원본 고객 메모 처음 40,000행을 공개 \`sealed.insert\`로 \`native_verify_main.attack_customers\`에 scope \`'_'\`로 재암호화했다. 처음 20,000행의 **실제 보조 테이블 토큰 배열**을 피해 덤프로, 다음 20,000행의 원문을 빈도 참고 자료로 썼다. 공개 리뷰는 처음 20,000행과 다음 20,000행을 같은 방식으로 메모리에서 분리했다. 키 없는 DB 스냅샷 공격자는 행별 토큰 배열과 1/5/10%의 알려진 원문 행을 가지며 키·토큰 계산 함수는 가지지 않는다. 시드 99 Fisher–Yates 순서의 중첩 표본이다. 빈도 순위 대조, 알려진 행 출현 집합 대조, 최대 6회의 인접·건너뜀 조각 일관성 전파를 [공격 스크립트](../../../verify-native/v2-attack.ts)로 실행했다.

해독률은 피해 행에 저장된 조각 등장 횟수 기준이다. \`80%+\`는 알려진 행을 제외한 피해 행 중 전체 조각의 80% 이상을 정확히 맞힌 비율이다. 공격의 추정이 틀린 경우는 정답으로 세지 않았다.

| 덤프 | 공격 | 조각 해독 | 모르는 행 80%+ |
|---|---|---:|---:|
${rows.join('\n')}

상수 scope DB 메모에서 고유 조각 ${attack.db.uniquePieces}개, 고유 토큰 ${attack.db.uniqueTokens}개를 관찰했다. 옛 엔진 [V2 기록](../../2026-09-27-core-verification/v2/report-ko.md)의 DB 메모 10% 원문+일관성은 48.92%, 이번 네이티브 경로는 ${fmt(attack.db.known[2].consistency.allPct)}%다. 공개 리뷰의 같은 지표는 옛 기록 29.96%, 이번 ${fmt(attack.memory.known[2].consistency.allPct)}%다. 프로필은 동일하지만 모델 ID·scope와 HMAC 토큰 충돌 배치가 다르고, 옛 DB 보조 테이블과 새 파생 테이블도 달라 이 차이를 개선이나 악화의 효과로 분리할 수 없다. 양쪽 모두 알려진 원문과 행별 조각 공출현의 누출을 확인한다.

## 짧은 필드와 물리 색인

별도 주 고객 테이블(고정 UUID scope)의 전화·이메일·이름 각 20,000행에서 암호문 길이와 exact 토큰을 읽어 알려진 행의 동일 \`(길이, 토큰)\` 후보를 모르는 행에 전파했다. 아래 복원은 1/5/10% 알려진 행 순서다. 모든 표본의 암호문 오버헤드는 UTF-8 평문보다 29바이트였다. 이 실험은 상수 \`'_'\` 메모 공격과 scope가 다르다.

| 필드 | 암호문 길이 종류 | 서로 다른 원문 | 서로 다른 exact 토큰 | 원문 복원 1/5/10% |
|---|---:|---:|---:|---:|
${shortRows}

알려진 행 전파에서 0행 복원은 안전성 증명이 아니다. 키 없는 공격자가 정확 토큰을 임의 후보에 대입하는 기능을 가진다는 가정도 하지 않았다. 주 고객 보조 테이블의 6개 부분 검색 열을 포함한 다중 컬럼 GIN 정의는 [attack.json](attack.json)에 기록했다. 실제 행별 토큰 배열은 공격 중 메모리에서 사용했으며 원시 덤프를 저장소에 넣지 않았다. 물리 GIN 페이지·WAL·다중 스냅샷·쿼리 관찰은 측정하지 않았다.

## 판정

토큰 재계산 동일성은 표본 범위에서 **통과**다. 기계적 공격은 상수 scope에서 상당한 조각 누출을 재현했으며, 이는 현재 조각 토큰 설계의 **한계**다. 이 결과는 사용한 공격 목록에 대한 누출의 하한일 뿐 보안 인증이나 운영 성능 수치가 아니다. 재현: \`rtk proxy node --import tsx bench/verify-native/v2-tokens.ts\`, \`v2-load-constant.ts\`, \`v2-attack.ts .local/ratings.txt\` 순서로 실행한다.
`;
writeFileSync(`${root}/report-ko.md`,md);
