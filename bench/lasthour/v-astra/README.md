# 마지막 회귀용 공개 API 적재

`load.ts`는 `bench/final-return/load-product.ts`의 공개 API 적재 방식을 새 소유 스키마 `test_lasthour_product`에 적용한다. 보호 fixture의 원문 여섯 칸을 읽기만 하며 4연결·500행 배치로 100000행을 적재한다. 새 데이터 생성·SQL 복제·제품 코드 변경은 없다.

최신 제품 빌드 뒤 해당 HEAD를 지정한다.

```text
rtk proxy npm run build
rtk proxy node --import tsx bench/lasthour/v-astra/load.ts --commit <HEAD>
```

`connect(4)`는 일회용 클러스터와 포트를 확인한다. 기존 스키마가 있으면 중단하며 자동 삭제·교체·재개하지 않는다. 마이그레이션, `extraMigrationSql`, 적재, `ANALYZE` 뒤 부모/검색 표 각100000행과 첫100행의600칸 원문 복호화를 단언한다. 시간 기록은 진행 확인용이며 격리 성능 수치가 아니다. 실제 회귀 시간 측정의 락은 인계받는 측정자가 잡는다.

측정자는 `product.ts`의 동일 공개 API 등록을 가져올 수 있다. 키·scope·검색 설정과 원문 해시는 `bench/results/2026-09-29-lasthour/v-astra/load.json`에 남는다. 완료 직후 r9-impl과 코디네이터에게 스키마를 인계하며, 전체 회귀가 끝난 뒤 인계받은 측에서 삭제한다. 적재 담당자는 회귀에 필요한 스키마를 먼저 삭제하지 않는다.
