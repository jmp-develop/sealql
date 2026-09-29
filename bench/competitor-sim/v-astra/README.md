# 비교 실험 독립 검산

제품 코드와 DB를 바꾸지 않고 메모리 결과만 검산한다. 공통 모델·공격 파일은 r9-impl, A/B는 m1-astra 소유다. 기존 고정 fixture 재생 값은 앞선 실제 DB 원문 읽기의 전체 값 해시와 대조한다.

다른 작업자의 실행이 끝나 `complete:true`가 된 후 실행한다.

```sh
rtk proxy node --import tsx bench/competitor-sim/v-astra/verify-models.ts
rtk proxy node --import tsx bench/competitor-sim/v-astra/verify-attacks.ts AB
rtk proxy node --import tsx bench/competitor-sim/v-astra/verify-attacks.ts C
rtk proxy node --import tsx bench/competitor-sim/v-astra/verify-observed.ts
rtk proxy node --import tsx bench/competitor-sim/v-astra/verify-observed-graph.ts
rtk proxy node --import tsx bench/competitor-sim/v-astra/verify-samples.ts
rtk proxy python -X utf8 bench/competitor-sim/v-astra/report.py
rtk proxy node node_modules/typescript/bin/tsc --project bench/competitor-sim/tsconfig.json --noEmit
```

`verify-models`는 WebCrypto로 원시 연산을 독립 구현한 모델 검산이다. A/B는 모든 저장 witness 예측을 공개 공격 함수로 재실행하며, C/D는 저장 예측 전체를 독립 채점하고 표본 또는 전체 공격을 재실행한다. D의 검색어 미상 분기는 정답 label을 제거한 관찰에서 label 추정부터 다시 수행한다. 이는 새로운 최적 공격의 개발이나 외부 SDK 전체의 상호운용성 검증은 아니다.

보고서는 같은 조건의 이름 있는 완전한 공격 실행 중 복원율 최대값을 고른다. 각 행마다 정답을 보고 다른 공격을 선택하지 않는다. 전체 값 복원율과 글자 복원율을 구분하고, 기능 미지원과 미측정을 0%로 처리하지 않는다.
