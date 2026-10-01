# hardened 통합 근거

| 범위 | 보고·원자료 | 해석 |
|---|---|---|
| 백업·알려진 원문·선택 삽입·관찰 공격 | [보고](attack/report-ko.md), [독립 검산](attack/verification.json), [추가 검산](attack/verification-extra.json), [보존 manifest](attack/manifest.json) | 기계적 메모리 모델, 피해·참조 각 1만 행. 0%는 안전 증거가 아니며 미열거·상한·다중해답을 미해결로 남김 |
| 일반 버전·초기 hardened 성능 | [보고](perf/report-ko.md), [raw](perf/raw.json), [manifest](perf/manifest.json) | v1.1.1 대 4c83aae 및 실제 1만/10만 행 평문·일반·hardened. 초기 최고 약 160배는 목록 경로 최적화 전 전체 시간 측정이며 최신 목록은 아래 참고 |
| 채택한 목록 경로 전후 | [보고](list-plan/report-ko.md), [raw](list-plan/raw.json) | 9f19c2e 대 최종 직접 ordered proof scan, 교차 7회·예열 2회·34조건·총 1,420개 결과 비교 |
| 직접 경로 첫 탐색 / 기각 대안 | [첫 탐색](list-plan-direct/raw.json), [기각 대안](list-plan-rejected/raw.json) | 결과 빈도를 모르므로 proof-first 전체 fallback을 자동 선택하지 않음. 0건·LIKE 개선과 중간 빈도 퇴행을 같은 세션에 보존 |
| 기본 SQL·파라미터 불변 | [217항목 증거](verification/standard-bytes.json), [1aea703 baseline](verification/standard-before.json), [최종](verification/standard-after.json) | 전체 bytes 직접 비교, SHA-256 99033f1975b048405c79b3d58fdacfdab506cb79005f990ab523abf5a6910bda |

원래 두 작업자의 보고서와 JSON 원자료는 내용 그대로 복사했고 각 파일 hash를 manifest에 기록했다. 원래 .local 실행 스크립트는 당시 버전별 build 경로를 전제로 하므로 `.ts.txt`·`.mjs.txt` 형태의 **역사적 source snapshot**으로 보존했다. 현재 실행 도구와는 구분한다. capability·terminal 메시지·shell lifecycle 스크립트·빌드 및 node_modules 사본은 포함하지 않았다.

후보 토큰을 없애도 길이·compact 위치 순열은 남으며 알려진 검색어 관찰 1,000회는 전화·주소·회사 100%, 이름 70.41%로 일반 부분 검색과 같았다. 주소 백업 hardened 0.20% 대 정확 일치 0.16%처럼 모든 수치가 엄밀히 이하인 것은 아니다. 전환 전 백업·WAL에는 옛 토큰이 남으며, 토큰 없는 보장을 그 사본까지 적용하려면 폐기하고 유지하는 사본은 기존 프로필의 보호 기준으로 관리한다.

일회용 DB와 읽기 전용 기존 fixture만 사용했다. 공격 실험은 메모리 모델이며 낮은 성공률은 안전 증거가 아니다. 원자료의 실행 시간은 해당 환경·합성 fixture의 관찰로, 운영 보장·보안 인증·성능 동등성 증명이 아니다. 제품 쿼리·형식·키·도장 함수는 범위 내 검증과 함께 판단한다.

## 완료 검증

[게이트 결과](verification/gates.json)와 원문 로그: [build](verification/build.log), [check](verification/check.log), [test](verification/test.log)(48/48), [docs:check](verification/docs-check.log), [test:install](verification/test-install.log)가 모두 통과했다. 설치 검증은 Drizzle 0.45.2/0.45.3의 기존 upstream 선언 진단 제외 정책을 그대로 사용한다.

전체 시험을 시작한 뒤 추가한 문자열 ID의 첫 페이지·후속 커서는 [별도 DB 시험](verification/focused-postgres.log)(2/2)으로 확인하고 [최종 check](verification/check-final.log)를 다시 통과했다([결과](verification/additional-checks.json)). 같은 DB 시험은 UUID의 희귀 결과·AND/OR·후속 커서 종료도 검증한다. 217항목 SQL/파라미터의 저장 JSON은 전후 bytes가 같으며, 공격 보고에 기록된 제품 도장 구현 파일의 SHA-256도 변하지 않았다. 보존 원자료는 과거 세션과 최종 세션을 구분하며 결과·순서 비교와 성능 중앙값을 함께 읽어야 한다.
