# 감사로그(`query_log`) 설계 분석

> 대상: `edu/session-06.md` **5장 감사 로그 적재** (+ 4a 마이그레이션 `20260622000001_query_log_enrich.sql`, IP 기반 식별, 7장 admin 뷰어)
> 기준: HEAD `f0ff609` 실제 코드와 대조
> ※ 본 문서는 분석 결과(조치 전).

## 결론 한 줄
설계 방향은 타당하나 **현재 100% 미구현**이고, **계획서대로 그대로 구현하면 안 됨** — 실패 로그 누락 · IP 신뢰성 붕괴 · insert 유실 · 토큰 계측 과소설계 + 줄번호 대부분 stale.

---

## 현재 빌드 상태 (확인됨)

- `query_log` insert 코드 **0건**, `lib/db/query-log.ts` **없음**, enrich 마이그레이션 `20260622000001` **없음**, `ragChatStream`은 usage 버림 → **감사로그 전체 미착수**
- 베이스 테이블 `supabase/migrations/20260520000004_query_log_table.sql`만 존재: `user_id`(auth.users FK) · RLS self 정책(`query_log_select_self`) · `query_log_user_idx` 보유. `ip`·`route`·`top_score`·`message_count`·`below_threshold`·`gate_sufficient`·`out_of_scope`·`has_hallucination`·`ttft_ms`·`error_code`·`law_refs`·`citation_count`·`citation_verified_count`·`retrieved`·`answer_truncated` **없음**, 인용은 `citation_verified` 단일 boolean뿐.
- **계획서가 stale** — 같은 plan의 타 장들은 이미 부분 구현되어 어긋남:
  - ingest 잠금: 계획 **404**, 실제 **403**(시크릿 미설정)/**401**(불일치) — `app/api/ingest/route.ts:27-32`
  - 입력캡: 계획 `MAX_QUESTION_LEN`, 실제 **`MAX_CONTENT_CHARS`**(8000) + `MAX_TURNS`(30) — `lib/env.ts:24-25`, `isValidMessages`(`route.ts:137-151`)
  - 레이트리밋: 계획 "코드 전무, 경량 in-memory", 실제 **durable Supabase RPC 카운터**(`increment_rate_limit`)로 구현됨 — 단 기본 비활성(`RATE_LIMIT_ENABLED`)·fail-open·`/api/chat`에만 배선 — `lib/security/ratelimit.ts`
  - 에러 일반화: **미구현**(`route.ts:336` 원문 그대로)
  - 부팅가드: **미구현**(`env.ts:8-12` 4개 키 `.optional()`)
  - admin 페이지: **미구현**(`app/admin/**`·`middleware.ts` 없음)

---

## 🔴 Critical — 그대로 구현 시 잘못된/누락된 로그

### 1. 실패 쿼리가 아예 안 쌓임
계획(§5-4)은 insert를 `done` 직후(성공 경로)에 둠. 그러나 에러는 `route.ts:335-336` catch → `:337-338` close로 빠져 insert에 **도달 못 함**. 그런데 스키마엔 `error_code` 컬럼 추가(§5-3) → 자기모순. 운영의 핵심 신호(실패율)가 비게 됨.
→ insert를 **`finally`**(또는 성공/실패 양쪽 경로)에 두고 catch 시 `error_code` 채우기.

### 2. fire-and-forget insert에 durable 연속성 없음
ReadableStream `start()` 안에서 `controller.close()` 후 await 없이 호출 → Vercel Fluid Compute에서 함수 동결/회수 시 **insert 유실** 또는 응답 종료 후 **unhandledRejection**. 계획에 `after()`/`waitUntil()` 언급 없음.
→ `after(async () => { try{...}catch(console.error) })`(`next/server`) 또는 `waitUntil()`(`@vercel/functions`)로 응답 후 보장 실행(비차단).

### 3. 토큰/TTFT 계측 과소설계
`ragChatStream`(`lib/ai/llm-router.ts:181-222`)은 `AsyncGenerator<string>`로 text만 yield, 소비자 `for await`(`route.ts:270-273`)는 **generator return값을 못 봄** → "최종 usage 반환"이 그대로는 route에 안 닿음. 제너레이터 공개 계약 변경(최종 sentinel yield) 또는 `iterator.next()` 루프 리팩터/스트림 핸들 반환 필요(계획의 "그대로 담으면 됨"보다 큼).
※ `stream.finalMessage().usage` 자체는 `for await` 델타 루프와 충돌하지 않음(누적 상태 반환, 재소비 아님) — 단 제너레이터 내부에서 호출해 밖으로 노출해야 함.

---

## 🟠 Important

### 4. "4장 IP 헬퍼 공유"는 사실이 아님 + IP 위조 가능
공유 헬퍼 모듈 없음 — IP는 `route.ts:168`에서 인라인 `x-forwarded-for.split(",")[0]`(**좌측 = 클라이언트 조작 가능**). 레이트리밋엔 우회, **감사로그엔 책임추적 근거가 위조/타인 전가 가능** → no-login 결정의 전제(IP 책임추적)가 무너짐.
→ Vercel 신뢰 IP(`x-vercel-forwarded-for` / `ipAddress(req)` / 우측 신뢰 hop)로 한 번 추출해 `checkRateLimit`·로그 row가 같은 값 공유.

### 5. `session_id` 미적재로 대화 그룹화 불가
베이스 테이블엔 `session_id`(`20260520000004:4`) 있으나 route가 생성/수신 안 함. 계획은 `message_count`만 추가. IP만으론(NAT 공유) 멀티턴 재구성 불가.
→ client 전송/서버 발급 `session_id` 도입하거나 한계 명시.

### 6. `answer_truncated`·`error_code`는 생산 코드 없음
`route.ts`에 truncation 로직 없음(`answerText` 전량 누적) → `answer_truncated` 상수. `error_code`는 #1 해결 + 에러 분류 추가해야 의미. 소스 없는 컬럼 = 죽은 스키마.

### 7. 로그에서 빠뜨린 파이프라인 신호
- (a) 판례 retrieval(`route.ts:223-251`, `precedentSources`)은 `law_refs`만 남고 판례 ref/count 유실(평가 신호 손실)
- (b) **열화 플래그** — rerank 실패 RRF 폴백(`:81-88`)·법령/인용검증 실패(`:283-285`)가 기록 안 돼 `top_score`가 RRF인지 rerank인지 구분 불가
- (c) 게이트 호출(`isInScope`/`isRegulationSufficient`, `max_tokens:8`) 토큰이 `tokens_in/out`에서 누락 → 비용 집계 구조적 불완전

### 8. 개인정보 보존정책 미결
로그인 없이 raw `query`+`answer`+`ip` 저장 = PIPA 이슈(IP·자유서술은 개인정보, 질의에 개인정보 포함 가능). 보존기간·삭제 job·마스킹 미정의로 docs/07 §10에 무기한 위임.
→ **출시 전 결정 필수.**

---

## 🟡 Minor
- `message_count`는 턴 수가 아니라 `messages.length`(user+assistant) — 의미 불일치(계획은 "턴 깊이")
- `cited_law_refs` jsonb를 기존 `[{law,article,date}]`에서 verdict 배열로 용도변경 → 컬럼 주석 드리프트(문서화 필요)
- 마이그레이션 drop 순서: 정책(`query_log_select_self` `:30-33`)·인덱스(`query_log_user_idx` `:24`)를 `user_id`보다 **먼저** drop
- `ttft_ms`는 요청 시작~첫 토큰(검색+rerank+게이트+법령 포함, `:189-251`)이라 순수 LLM TTFT 아님 — 주석 필요

---

## Stale 줄번호 (구현자 오인 위험)

| 계획 주장 (§5-2/§5-4) | 실제 현재 위치/변수 |
|---|---|
| `ip` "4장 헬퍼 공유" | 헬퍼 없음, 인라인 `route.ts:168`(`x-forwarded-for.split(",")[0]`), `checkRateLimit`에만 전달 |
| `query` `:168` | `:168`은 IP, query는 `:177` |
| `answer` `:258-264` | `:258-264`는 `console.log`, answer는 `answerText` `:267-273` |
| `message_count` `:158` | `:158`은 `"invalid json body"`, 소스는 `body.messages.length` |
| `route` `:206-207,250` | 계산 `:209`/`:215-216`, 문자열 `:259` |
| `top_score(maxScore)` `:194` | `:203` |
| `below_threshold/gate_sufficient/out_of_scope` `:195-207` | `:204`/`:211-213`/`:209` |
| `retrieved_doc_ids/retrieved` `:181` | `:181`은 `send` 헬퍼, `sources` `:190`, `retrievedDocs` `:192` |
| `law_refs` `:244-247` | `:244-247`은 판례 본문 fetch, `lawRefs` `:253-256` |
| `cited_law_refs/citation_*` `:270-323` | `citationCheck` `:279-286`, `verdicts` `:289`, `hasHallucination` `:326` |
| `llm_model` `:338` | `:338`은 `controller.close()`, `env.LLM_MODEL` `:260`/`:347` |
| ttft "첫 delta `:263`" | 델타 루프 `:270-273` |
| insert "`done` 직후 `:325`" | `done`은 `:334`, `:325`는 citations 이벤트 |
| `ragChatStream` `:181-222` usage 반환 | text만 yield, usage/return 미노출 |
| env `MAX_QUESTION_LEN` | 실제 `MAX_CONTENT_CHARS`(`env.ts:25`) |
| ingest "404" | 실제 403/401 |

---

## 구현 전 결정할 것
- **IP 신뢰 소스**: 좌측 XFF 금지, Vercel 신뢰 IP 채택 + IP 부재/위조 시 처리
- **보존·마스킹(PIPA)**: 보존기간·삭제 메커니즘·`query`/`answer`/`ip` 마스킹 여부
- **실패 로깅 여부**: `finally` insert + `error_code` 분류 도입 vs 성공-only(이 경우 `error_code`/`answer_truncated` 제거)
- **durable insert**: `after()`/`waitUntil()` 선택, fail-open 계약(로그 실패가 응답을 막지 않음)
- **session 그룹화**: `session_id` 도입 vs 한계 명시
- **RLS 최종형**: insert/select 정책 없이 service_role 우회만 단일 접근 경로 확정, anon 키는 `query_log`에 절대 미사용

---

## 판정 — 5장 그대로 구현 가능?
**No — 수정 후 구현 가능(With revisions).** 스키마 enrichment·RLS 모델은 유지할 가치가 있으나, 그대로 따르면 성공 쿼리만 기록 · 위조 가능 IP에 의존 · insert 유실 · 토큰/TTFT 계측 과소로 **불완전·불신뢰·부분 무책임추적**의 감사로그가 됨. 4개 핵심(실패경로 `finally` insert, `after()`/`waitUntil()`, 신뢰 IP, 제너레이터 usage 배선) 수정 + stale 앵커 갱신이 선행되어야 함.
