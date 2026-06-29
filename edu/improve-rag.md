# RAG AI 챗 개선 리뷰

> 대상: `app/api/chat/route.ts` 외 RAG 챗 파이프라인 (HEAD `f0ff609`, main)
> 기준 컨셉:
> 1. RAG에 관련 참조문서가 있으면 → **RAG 문서(내부 규정) 기반 답변**
> 2. 없으면 → **law search(법제처) 참조문서 기반 답변**
> 3. 사용한 **각 참조문서를 응답 하단에 표시**
>
> ※ 본 문서는 리뷰 요약(조치 전). 보안·인증 항목은 별도 범위.
> ※ 2026-06-27 독립 리뷰(서브에이전트)와 교차 검증 완료 — C1·C2·I3·I5·I7 재확인, 신규 항목은 하단 "교차 검증" 절 참조.

## 컨셉 정합성 요약

| 컨셉 | 상태 | 핵심 이유 |
|---|---|---|
| ① 규정 있으면 규정 답변 | ⚠️ 부분 | happy path OK. 단 rerank 실패 시 전부 law로 오라우팅(I3), 검색 0건 시 근거 없이 답변 가능(C1) |
| ② 없으면 law 답변 | ⚠️ 부분 | 동작하나 표시 소스가 "검색된 조문"이 아니라 "모델 인용 후 실존 확인"(I5), 법제처 timeout 없음(I7) |
| ③ 사용한 참조문서 하단 표시 | ⚠️ 부분 | 규정 분기는 정확(표시=사용). law 분기에서 **소스 0건 표시** 케이스 존재(C2) |

구조 자체는 컨셉대로 배선됨. 문제는 **분기 경계 · 실패 경로 · 표시 일치**에서 컨셉이 깨지는 지점.

---

## 🔴 Critical — 컨셉 직접 위반

### C1. 검색 0건일 때 근거 없이 파라메트릭 답변 (환각)
- 위치: `route.ts:267-269` → `lib/ai/llm-router.ts:191-197`
- 내용: 규정 검색 0건 + law 컨텍스트 없음 → `hasContext=false` → `<context>` 없이 **원본 질문만** advisor 프롬프트로 전송. advisor 프롬프트(`prompts/prompts.md:29`)는 "자료 비었고 잡담이면 거절"만 단호 지시 → in-scope 법률 질문 + 빈 검색이면 모델이 자기 지식으로 답변 가능.
- 영향: "문서 기반 답변" 컨셉 위반, 환각 위험.
- 개선: in-scope인데 컨텍스트 없으면 결정론적 거절("확인된 자료에 없습니다 / 소관 부서·법제처 확인") 또는 파라메트릭 답변 금지하는 빈-컨텍스트 지시 주입.

### C2. 규정 근거로 답변했는데 소스 0건 표시
- 위치: `route.ts:303-309` (표시 분기), `route.ts:268` (answerDocs)
- 내용: score≥임계값이나 적합성 게이트가 `false` → `routedToLaw=true` → `searchAiLaw` 빈 결과 → `lawSources/citationSources=[]`. 그런데 `answerDocs = retrievedDocs`라 **답변은 규정 청크로 생성**됨. 반면 `displayedSources = [...lawSources, ...precedentSources] = []` → **사용한 규정 문서가 하단에 안 뜸**.
- 영향: 컨셉 ③ 위반.
- 개선: law 분기가 law/citation 소스를 못 만들면 실제 모델에 넣은 규정 `sources`를 표시로 폴백.

---

## 🟠 Important — happy path는 되나 실패/불일치

### I3. rerank 실패 시 전 쿼리 law 오라우팅 (스케일 불일치)
- 위치: `route.ts:85-87` → `203-204`, `lib/env.ts:39`
- 내용: Cohere 실패 폴백이 `score=rrf_score`(~0.02–0.03)인데, 이를 Cohere 스케일 `RELEVANCE_THRESHOLD=0.15`와 비교 → 항상 `belowThreshold=true` → 좋은 규정 매치도 전부 law로. UI엔 "관련도 3%"로 표기.
- 영향: Cohere 장애 시 컨셉 ① 전역 붕괴.
- 개선: rerank 실패 시 임계값 비교 생략(규정 hit 있으면 규정 유지) 또는 RRF 전용 임계값 적용. 폴백 표식으로 cross-scale 비교 방지.

### I4. law 분기에서 탈락한 규정 청크를 계속 LLM에 주입하나 표시 안 함
- 위치: `route.ts:268`, `303-309`
- 내용: `answerDocs=retrievedDocs`가 law 분기에서도 무조건 주입 → 모델이 규정+법령 둘 다 받음. 컨셉은 이분법인데 실제론 혼합, 그 규정 청크는 표시 안 됨.
- 개선: law 분기에선 `answerDocs` 비우거나(진짜 이분법), 주입하면 표시에도 포함.

### I5. 표시 law 소스가 "검색된 조문"이 아닌 "모델 인용 실존 확인"
- 위치: `route.ts:288-298`
- 내용: `verifyCitations(answerText)` = 모델이 답변에 쓴 조문을 법제처에서 실존 확인. 검색에 없던 조문을 기억으로 인용해도 실존만 하면 근거로 표시(실존 ≠ 내용이 주장 뒷받침).
- 영향: 컨셉 ②("검색된 문서 기반") 부분 훼손.
- 개선: 검증 인용을 검색된 `lawSources`와 교집합하거나 "검증된 인용" vs "검색 근거" 시각 구분.
- 추가(교차 검증): `verifyCitations`는 (a) **사후·자문용** — 전체 스트리밍 후 실행이라 틀린 텍스트는 이미 화면에 출력됨(⚠ 배지만), (b) **`routedToLaw`일 때만 실행**(`route.ts:280`) → **규정 분기에서 모델이 법조문을 기억으로 인용하면 검증 자체가 안 됨**. → 분기 무관하게 법조문 인용 포함 답변은 검증하고, `hasHallucination` 시 UI 강조 검토.

### I6. `max_tokens: 4096`로 긴 법률 답변 잘림 + 인용추출 오염
- 위치: `lib/ai/llm-router.ts:203`
- 내용: 결론+조항요약+판례 형식은 4096 초과 가능 → 중간 잘림. 잘린 답변이 `verifyCitations`에 들어가 검증도 열화. 데드코드 `answerStream`은 16000+adaptive thinking으로 더 적절(M8 참조).
- 개선: `ragChatStream`의 max_tokens 상향, thinking 적용 검토. (모델 id/파라미터명은 Anthropic 최신 문서로 확인 후 변경)

### I7. 법제처 호출 timeout 없음
- 위치: `lib/law/client.ts:25-33`
- 내용: `getJson`이 에러는 null로 잘 삼키나(그래서 bare `Promise.all`은 크래시 안 함), **fetch에 AbortSignal/timeout이 없어** 법제처 hang 시 `maxDuration=300`까지 정지.
- 개선: `fetch(url, { signal: AbortSignal.timeout(4000) })` 추가. 기존 try/catch가 abort를 null로 변환하므로 그 외 변경 불필요.

---

## 🟡 Minor
- **M8.** `answerStream`/`chatStream`(`llm-router.ts:125-175`) 데드코드 — 라이브 경로와 설정 분기(이게 I6 원인). 제거 또는 통합.
- **M9.** 판례(precedent)는 컨셉(법령만)에 없는 scope creep(`route.ts:241-251`) — 의도 확인 필요.
- **M10.** 게이트 fail-open(true): LLM 일시 오류 시 조용히 규정 분기 유지(`llm-router.ts:86,121`).
- **M11.** `citationSources` score를 `1`(100%) 하드코딩(`route.ts:298`) → 신뢰도 과표기.
- **M12.** `RELEVANCE_THRESHOLD=0.15`는 다소 낮음(`env.ts:39`) — 실트래픽으로 튜닝.

---

## 우선순위
1. **C1, C2, I3** — 컨셉 직접 위반 · 전역 오라우팅. 오픈 전 필수.
2. **I4, I5** — "표시=사용" 일치 및 이분법 명확화.
3. **I6, I7** — 토큰 상향 + 법제처 timeout.
4. **M8~M12** — 정리 단계.

> 가장 임팩트 큰 개선: **C2 + I4** — 표시 로직(`route.ts:303-309`)을 "실제 모델에 들어간 문서 = 표시 문서"로 일치시키는 것이 컨셉 ③의 핵심.

---

## 교차 검증 (2026-06-27, 독립 리뷰 대조)

별도 서브에이전트가 HEAD `f0ff609` 코드를 본 문서 결론 없이 독립 리뷰한 결과와 대조.

**재확인(일치):** C1(=독립 C1, 규정 청크 주입+미표시), C2(=독립 C2, law 0건/장애 시 근거 없는 답변·소스 0건), I3(rerank 실패 → law 전역 오라우팅), I5(인용 검증 사후·자문용), I7(법제처 timeout 부재). 핵심 결론 변동 없음.

**차이(미해결 1건):** 본 문서 **I6(`max_tokens:4096` 잘림, `llm-router.ts:203`)** 은 독립 리뷰가 미언급. 실재 여부는 해당 라인 1줄 확인으로 판정 가능 — 조치 전 검증 필요.

**신규(별도 범위 — 본 문서 scope 밖, 포인터만):**
- **query_log 미적재** — insert 코드 0건, 실패 경로(`route.ts:335` catch) 미기록. → `edu/audit-log-analysis.md` 소관.
- **에러 원문 클라이언트 누출** — `route.ts:336`이 `(err).message` 원문 전송. → 보안/하드닝(docs/07) 소관.
- **인증 게이트 부재** — `middleware.ts` 없음, 레이트리밋 기본 비활성. → 오픈 전 하드닝(docs/07) 소관, 로드맵 기인지 항목.
