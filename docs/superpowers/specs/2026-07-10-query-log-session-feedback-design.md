# query_log 잔여 로깅 — session_id + feedback

- 날짜: 2026-07-10
- 상태: 설계 승인 → 구현
- 범위: query_log 의 남은 NULL 컬럼 중 `session_id`·`feedback` 을 실제로 채운다. `user_id`·`feedback_note` 는 범위 밖.

## 배경

`logQuery` 배선(2026-07-09) 이후에도 `session_id`·`user_id`·`feedback`·`feedback_note` 는 계속 NULL 이다.
- `user_id`: 로그인이 없어 채울 값이 없다 → 인증(별도 과제) 선행 필요. 이번 범위 제외.
- `session_id`: 클라이언트가 세션 식별자를 만들어 보내면 채울 수 있다.
- `feedback`: 사용자의 답변 평가(👍/👎)를 수집할 UI + 저장 경로가 없다. 특정 답변(=query_log 행)과의 상관관계가 관건.

## 결정

- **feedback 상관관계**: 서버가 삽입된 query_log 행 **id 를 반환**하고, 스트림 `meta` 이벤트로 클라이언트에 전달한다. 피드백은 그 id 로 행을 업데이트한다. **스키마 변경 불필요**(기존 `feedback smallint` 사용).
- **session_id 단위**: 대화당 UUID(첫 메시지 때 생성, '새 대화'에서 리셋) → session = 하나의 대화.
- `feedback_note`(사유 텍스트)는 보류(후속). 이번엔 👍/👎(=+1/-1)만.

## 설계

### A. session_id — 대화 단위

- 클라이언트(`app/page.tsx`): `sessionIdRef`. `send()` 진입 시 null 이면 `crypto.randomUUID()` 로 채운다. `resetChat()` 에서 null 로 리셋(다음 대화는 새 세션). `/api/chat` body 에 `session_id` 포함.
- 서버(`app/api/chat/route.ts`): `ChatRequest.session_id?: string`. UUID 형식일 때만 `logRow.session_id` 에 저장(`session_id` 컬럼은 uuid 타입이라 비-UUID 는 insert 실패 → 형식 불일치는 null 처리).

### B. feedback — 👍/👎

1. `lib/db/query-log.ts` — `logQuery` 가 삽입 행 id 를 반환하도록 변경: `insert(row).select("id").single()` → `number | null`(실패 시 null, 기존처럼 조용히 로깅). 반환 타입 `Promise<number | null>`.
2. `app/api/chat/route.ts`
   - StreamEvent 에 `{ type: "meta"; queryId: number }` 추가.
   - 성공 경로에서 `ttft_ms`/`total_ms` 확정 후 `const queryId = await logQuery(logRow)` (답변 스트리밍 종료 후라 체감 지연 없음), `logged=true`, `queryId != null` 이면 `send({type:"meta", queryId})` 후 `done`.
   - 에러 경로/미적재 시 finally 에서 기존처럼 fire-and-forget(`void logQuery`). `logged` 플래그로 이중 적재 방지.
3. `app/api/feedback/route.ts` (신규, runtime nodejs)
   - POST `{ queryId: number, value: number }`. 검증: `queryId` 양의 정수, `value ∈ {-1,0,1}`. 위반 시 400.
   - `getSupabaseAdmin().from("query_log").update({ feedback: value }).eq("id", queryId)`. 결과 200 `{ ok: true }`. 에러는 일반화된 500.
4. 클라이언트(`app/page.tsx`)
   - `Message` 에 `queryId?: number`, `feedback?: -1 | 1` 추가.
   - 스트림 파싱에 `meta` 케이스 추가 → 진행 중 답변 메시지에 `queryId` 부여(paint 에 포함).
   - 답변 푸터(복사 버튼 옆)에 👍/👎 버튼: `queryId` 있고 로딩 아닐 때만. 클릭 시 `/api/feedback` POST + 낙관적으로 `m.feedback` 설정. 같은 값을 다시 누르면 토글(0=취소)도 허용(선택).

### 데이터 흐름

```
send(): sessionIdRef ??= randomUUID()  --{messages, session_id}--> /api/chat
  route: logRow.session_id = uuid?  ... 답변 스트리밍 ...
         queryId = await logQuery(logRow)  --{type:meta, queryId}--> client
  client: assistantMsg.queryId = queryId → 👍/👎 렌더
  👍 클릭 --{queryId, value:+1}--> /api/feedback → query_log.feedback = 1
```

### 오류 처리

- session_id 비-UUID/누락 → null 저장(질의는 정상).
- logQuery insert 실패 → queryId null → meta 미전송 → 피드백 버튼 미노출(답변은 정상).
- /api/feedback 잘못된 입력 → 400. DB 오류 → 일반화된 500(내부 메시지 비노출).

### 검증 (PoC)

- `pnpm typecheck` / `pnpm build`.
- 실 호출: (1) 대화 중 session_id 가 여러 턴에 동일, '새 대화' 후 변경. (2) 답변 후 meta.queryId 수신 → 👍 클릭 → query_log.feedback=1 확인. 👎 → -1.

## 범위 밖

- `user_id`(인증 선행), `feedback_note`(후속), 다중 관리자, 피드백 엔드포인트 인증(현재 /api/chat 도 미인증 — 오픈 하드닝에서 일괄).
</content>
