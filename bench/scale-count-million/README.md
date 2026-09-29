# 100만 행 count 비용 실측

제품 코드 변경 없이 `rtk proxy node bench/scale-count-million/run.mjs [commit]`로 실행한다. 시작 시 지정 커밋(생략하면 HEAD)의 제품 소스를 git archive로 별도 빌드해 다른 작업자의 src/dist 변경과 분리한다. DB guard는 원래 `test/disposable.ts`를 호출하며 포트56439와 일회용 데이터 디렉터리를 확인한다. 기본 적재 중 강제 중단한 경우 같은 커밋으로 재개하면 실제 부모·검색 표의 행 수를 대조하고 미적재 원본 ID만 넣는다. 측정·복제 중간 재개는 지원하지 않는다.

1. 원본 fixture 10만 행의 6칸 원문을 공개 `sealed.insert`로 적재한다(500행×4연결). 배치마다 공통 측정 락을 취득·반납하고 다음 배치 전1초를 양보한다. 적재 속도는 진행 예상용이며 제품 쓰기 성능 주장이 아니다.
2. HEAD 함수 extraMigrationSql을 재설치하고 원본10만 행의 55개 count+LIKE 목록300 3개를 평문 정규화 oracle로 검증한다. 연구 기준선은 재적재하지 않고 기존6fc43de 세션 대비 ±15% 초과 조건만 보고한다. 이어서 평문/제품 count6조건을 병렬도2/4/8에서 비교한다. 첫 호출 별도, 예열2, 회전7회 중앙값이다.
3. 부모·검색표·평문을 새 결정적ID로9회 SQL복제한다. 도장·salt·토큰·암호문을 보존한다. **복제 파생, 개수 세기 비용 측정 전용, 목록 복호화 측정 불가.** 원본100개×9복제본의 비ID 열 값 일치를 표마다 확인한다. 자기 표의 비고유 보조 색인만 제거·동일 정의 복원한 뒤 VACUUM ANALYZE한다.
4. 같은 물리 연결에서 100만 행을 같은 방법으로 측정하고 매회 원본 oracle count×10과 비교한다. EXPLAIN ANALYZE BUFFERS는 교차 측정 후 별도 실행하며 실제 worker 계획/기동 수를 보존한다. 전역 서버 설정은 바꾸지 않는다.
5. 완료·오류 모두 자기 스키마 `test_scale_count_million_v_astra`를 삭제하고 원시 증거를 보존한다. 보고서는 `rtk proxy node bench/scale-count-million/report.mjs`로 작성한다. 실행 중 서비스 흐름 추가 측정이 취소되어 해당 실행은 count 반복이 끝난 뒤 멈추고 `finalize.ts`로 남은 EXPLAIN·용량·정리만 수행했다. `service-cancellation.json`에 중단 지점을 보존하며 count 중앙값은 같은 기존 연결에서 완료된 7회 반복만 사용한다.

결과: [한국어 보고서](../results/2026-09-29-scale-count-million/report-ko.md). 복제 데이터의 동일 일치 비율에 대한 실험이며 실제100만 행의 다양성·목록 복호화·운영 성능·보안 성질을 대표하지 않는다. 보호 스키마는 읽기만 한다.
