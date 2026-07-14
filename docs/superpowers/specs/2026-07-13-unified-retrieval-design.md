# 통합 검색(규정 RAG + 법령) 리랭킹 개편 설계

> 2026-07-13. 사용자 승인 결정: 전면 통합 · 순수 단일 풀 top-K · 표시=주입분+관련도% · 인용 검증은 환각 배지로 강등 · 시스템 프롬프트에 자료 기반 답변 강제.

## 배경

기존 챗 파이프라인은 규정 관련도(maxScore)로 규정/법령을 **이분법 분기**했다(법령 분기에선 규정 청크 미주입). "규정 + 법령 둘 다 근거가 필요한 질의"에서 한쪽 근거가 버려지는 문제.

## 새 파이프라인 (app/api/chat/route.ts)

```
병렬: regulationSearch(30) ∥ fetchAiLawCandidates(법제처 aiSearch ≤50 조문) ∥ searchDecisions(판례 2, 투기적)
  → 통합 Cohere rerank 1콜 (질의 원문, 규정청크+법령조문, topN=RERANK_TOP_K=5)
  → maxScore < RELEVANCE_THRESHOLD(0.33) ? isInScope 게이트 → 범위밖 거절 or 근거 없는 정직 답변
  → 주입 = top-5 중 score ≥ 0.33 (규정→retrievedDocs 섹션, 법령→lawContext 섹션)
  → 주입분에 법령이 있으면: 판례 본문 회수 + Cohere 필터(기존 로직) → lawContext·카드 보강
  → Claude 스트리밍 → verifyCitations(모든 답변, retrieved=법령 후보 전체 맵) → citations 이벤트(배지 전용)
  → 참조문서 = 주입분 그대로 (+판례). 인용 기반 카드(citationSources) 폐지.
```

## 핵심 결정

| 결정 | 근거 |
|---|---|
| 리랭킹은 route에서 단 1회 (searchAiLaw 내부 rerank 제거) | 이중 Cohere 호출 제거 + 규정·법령 동일 잣대 점수 |
| 결정론 보정(+0.15/−0.05) 폐기 | 순수 단일 풀(사용자 선택). 곁가지 법령 억제는 규정과의 경쟁 + 항목별 임계치 필터가 담당 |
| 주입 항목별 바닥 = RELEVANCE_THRESHOLD | 저득점 법령 조문이 top-5 말석에 끼어 권위 근거로 오인되는 환각 차단 (기존 노출 게이트 계승) |
| 판례는 통합 풀 밖 (조건부 보강) | 본문 회수 왕복 비용. 주입분에 법령 있을 때만 회수·필터 |
| rerank 실패 폴백 = 규정 RRF 상위 5 (법령 버림) | 교차 소스 점수 부재 시 안전한 강등. 서버 로그로 노출 |
| verifyCitations 전 답변 실행, 배지 전용 | 인용 0건이면 API 호출 0회. 프롬프트 강제(자료 밖 인용 금지) 위반 감지 = 환각 감지 |
| 제거: isRegulationSufficient·RELEVANCE_GRAY_UPPER·RELEVANCE_GATE_PROMPT·routing 이벤트·searchAiLaw | 분기 소멸로 무용. 프런트는 routing 미소비 |
| query_log.route = "unified" \| "out_of_scope" | text 컬럼(제약 없음, 마이그레이션 불필요). 과거 regulation/law 행은 관리자에서 레거시 표시 유지 |

## 변경 파일

1. `lib/law/search.ts` — `fetchAiLawCandidates` 신규(원시 조문 + RetrievedLaws 전체 맵), `searchAiLaw`·`rerankAiHits` 제거
2. `prompts/prompts.md` — advisor에 자료 기반 답변 강제 조항, relevance-gate 섹션 제거; `lib/ai/prompts.ts` export 정리
3. `lib/ai/llm-router.ts` — `isRegulationSufficient` 제거
4. `lib/env.ts` + `.env.local` — `RELEVANCE_GRAY_UPPER` 제거
5. `lib/db/query-log.ts` — route 유니온에 "unified"
6. `app/api/chat/route.ts` — 통합 파이프라인 재작성
7. `app/page.tsx`·`components/ui/source-panel.tsx` — 법령·판례 카드에도 관련도 %, hasHallucination 경고줄
8. `app/admin/page.tsx`·`charts.tsx`·`log-table.tsx` — "unified" 라우트 표시·필터·도넛
9. `docs/09-chat-flow.md` 재작성, `docs/04` 흐름 갱신, `docs/08` 이슈 A·B 해소 주석, `CLAUDE.md` 흐름 문구 갱신

## 구현 중 추가 결정 (2026-07-13)

- **sources 이벤트 선발송** — 통합 구조로 표시분이 스트리밍 전 확정되어 delta 앞에 발송.
  docs/08 이슈 A(중단 시 참조 소실) 해소.
- **인용 정규식 보강** (`lib/law/verify.ts`) — 마크다운 강조(`**제19조**`) 통과 허용,
  접미사에 `규정` 추가(대통령령급 누락 방지), 무변별 단독 토큰("규정 제N조") 스킵 가드.
- **DB 마이그레이션** `20260713000001_query_log_route_allow_unified.sql` — 원격 DB에
  마이그레이션 파일에 없던 `query_log_route_check` 제약(드리프트)이 있어 'unified' 적재가
  실패 → 제약을 마이그레이션 관리로 편입하며 'unified' 허용. 원격에는 풀러 직결로 적용하고
  히스토리(schema_migrations)에 기록. ※ 원격에 로컬에 없는 20260623000001/2(faq_*) 버전이
  있는 별도 드리프트 발견 — 추후 `supabase db pull` 정리 필요.
- 구식 분기 재현 스크립트 `scripts/test-rag-routing.ts` 삭제, `test-route-decision.ts` 를
  통합 리랭킹 진단으로 재작성, `test-ai-law`·`test-law-compare`·`chat-smoke`·`test-chat-e2e` 갱신.

## 검증

`pnpm typecheck` → `pnpm build` → `pnpm dev`에서 규정형/법령형/혼합형/잡담 질의 curl로 NDJSON 확인(sources 혼합·score, citations, out_of_scope).

## 관찰 리스크 (수용)

- 매 질의 법제처 왕복으로 TTFT 증가 (병렬화·6h 캐시·실패 시 규정 단독 강등으로 완화)
- 규정 청크 vs 법령 조문 점수 분포 차이 — retrieved 로그로 관찰 후 임계치 재조정
- below_threshold 로그 의미가 "규정 최고점"→"통합 최고점"으로 변경


## 후속 개편 — 복합 질의 의도 분해 (2026-07-14, B안 승인)

문제: "기금 처리절차 + 기업 회생절차" 복합 질의에서 채무자회생법이 ①법제처 후보 미진입
(지배 의도가 의미검색 독점) ②원질의 기준 리랭킹 0.05~0.16(문턱 미달)로 이중 탈락.

해결: `decomposeIntents`(Haiku, prompts.md intent-decompose) — 원질의 검색과 병렬 발사
(단일 의도 질의는 TTFT 증가 0) → 복합 의도면 의도별 검색·의도별 리랭킹 → B안 선발
(의도별 top-2 완화 문턱 0.25, 상한 ⌈K/N⌉, 인터리브 병합) → **명시 법령 한정**(의도에
법령 정식명칭이 있으면 그 의도의 법령 픽을 그 법령 조문으로 한정 — 곁가지 억제).
retrieved 맵은 전 의도 병합(mergeRetrievedLaws)으로 인용 검증 재사용 유지.
로그: query_log.intents jsonb (마이그레이션 20260714000001, 원격 적용·히스토리 기록 완료).

검증(실서버): 대상 질의 주입이 규정 3 + **채무자회생법 제34조(개시신청)·제3조(관할)·
제6조(폐지→파산)** 로 교정, 답변이 조문 근거 실설명으로 개선. 회귀(규정형·잡담) 무결.
