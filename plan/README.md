# plan/ — 진행 중인 계획

이 폴더에는 **진행 중이거나 앞으로 할 계획만** 둔다. 현재 구현 상태는 [`docs/current-state.md`](../docs/current-state.md), 확정된 결정과 근거는 [`docs/decisions/`](../docs/decisions/README.md)에 있다.

## 규칙

1. 계획은 `NNN-<슬러그>.md`로 쓴다. 번호는 이 폴더의 가장 큰 번호 다음을 쓴다.
2. 머리에 작성일, 상태(제안 | 확정 | 진행 중), 관련 결정 기록을 적는다.
3. 수치에는 출처를 붙인다: 공식 문서, 실측(`bench/results/` 링크), 인용, 미확인.
4. 계획은 작업을 정하는 문서이며 구현 완료나 실측의 증거가 아니다. 제안·구현·검증 완료를 같은 상태로 적지 않는다.
5. **계획이 끝나면** 결정과 근거를 `docs/decisions/`에 새 번호로 요약하고, `docs/current-state.md`를 갱신한 뒤 **이 폴더에서 지운다.** 실측 원본은 `bench/results/`에 남는다.
6. 계획 도중 기존 결정을 바꾸게 되면 결정 기록을 덮어쓰지 않고 새 결정 기록을 추가한다.

## 현재 계획

없음. Drizzle 네이티브 API 계획(001)은 구현이 끝나 [`docs/decisions/013`](../docs/decisions/013-drizzle-native-api-implemented.md)로 요약하고 지웠다.
