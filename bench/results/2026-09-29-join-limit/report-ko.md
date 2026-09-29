# JOIN 콜백 limit 타입 검증

필수 `limit: number`를 주는 search 호출은 콜백의 limit를 number로 추론한다. 생략·선택적 속성·undefined 가능한 값은 기존 number | undefined를 유지한다. 숫자 리터럴로 좁히지 않으며 반환 행과 복호화 필드 추론을 보존한다. `examples/standard-raw.ts`의 Drizzle 예제가 `.limit(limit)`를 직접 사용한다.

타입 변화 외 런타임 JS가 동일함을 [비교 결과](runtime-equivalence.json)로 확인했다. Git/체크아웃의 CRLF를 LF로 맞추고 주석을 제거한 TypeScript ES2022/ESNext 출력이 같으며 SHA-256은 `eb6dbedc83034c948f8e56d60ad391126797187e99dc331a39e9c86c2ffeb593`다.

`npm run build`, `npm run check`, `npm test`, `npm run docs:check`, `npm run test:install`이 모두 exit 0으로 통과했다. 실제 테스트 출력은 `tests 39 / pass 39 / fail 0 / duration_ms 101263.1607`이며 Node pg·postgres-js·local workerd pg 공개 흐름도 모두 `ok:true`다. 설치 검증은 Drizzle 0.45.3·0.45.2에서 통과했고 기존 upstream 선언 진단 70건씩을 제외했다. 실제 출력은 같은 폴더의 gate 로그에 보존한다. 성능 측정은 이 타입 개선의 범위가 아니다.

숫자 limit를 Drizzle에 직접 전달하는 예제와 생략·선택적·undefined 가능한 limit의 음성 타입 검사가 통과했다. 런타임 변경과 새 DB 설치·재색인은 없으며 이 작업의 필수 게이트 중 미검증 항목은 없다.
