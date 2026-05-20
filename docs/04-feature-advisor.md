# ① 규정법령 어드바이저

> 일정: **2026년 5~7월**. PIMS 첫 번째 모듈이자 핵심 가치 모듈.

## 1. 목표

- ICT기금 **내부 규정·지침·해석사례** + **국가법령정보(법제처)** 두 소스를 종합해, 사용자 질의에 **출처가 명시된 신뢰 가능한 답변**을 생성한다.
- 환각(hallucination)을 최소화하기 위해 **답변 내 인용을 법제처 DB와 자동 교차 검증**한다.

## 2. 입력·출력

### 입력

```json
POST /api/chat
{
  "query": "사업비 집행 시 증빙서류는 어떤 것이 필요한가?",
  "session_id": "uuid (옵션)",
  "user_id":    "uuid (옵션)"
}
```

### 출력

`text/plain` 스트리밍. 클라이언트는 토큰 단위로 화면 갱신. 응답 종료 시 `query_log`에 비동기 적재.

### 예시 답변 구조

```
1. 결론
   사업비 집행 시 증빙서류는 ...

2. 적용 조항
   - 「ICT기금 운영규정」 제12조 제2항 (출처: ICT-OP-2024-008)
   - 「국가재정법」 제54조 (출처: 법제처 법령 ID 12345)

3. 적용 시 유의사항
   ...

4. 근거 목록
   [1] ICT기금 운영규정 제12조 제2항 (2024.05.17 시행)
   [2] 국가재정법 제54조 (2023.12.31 개정)
```

## 3. RAG 파이프라인 (전체 흐름)

```
사용자 질의
    │
    ▼
[Step 1] Hybrid Search (lib/db/search.ts)
   Supabase RPC: hybrid_search(query_text, embedding(query), match_count=30)
   - tsvector(BM25 유사) + pgvector(내적) + RRF 결합
   - documents 테이블에서 상위 30건 반환
    │
    ▼
[Step 2] Rerank (lib/ai/rerank.ts)
   Cohere rerank-v4.0 multilingual → 상위 8건 재정렬
    │
    ▼
[Step 3] LLM 답변 생성 (lib/ai/llm-router.ts)
   Claude Sonnet 4.6 messages.stream({
     tools: lib/law/tools.ts (17개),
     system: SYSTEM_PROMPT (캐싱),
     messages: [{ user: <context> + query }]
   })
    │
    ├─ Claude가 도구 호출 결정 시:
    │    → lib/law/handlers.ts에서 법제처 API 호출
    │    → 결과를 tool_result로 회신
    │    → 다시 Claude 호출 (tool_runner가 자동)
    │
    ▼
[Step 4] 스트리밍 응답 + 로그 적재
   - 토큰 단위 SSE 또는 텍스트 스트림
   - 종료 시 query_log INSERT (fire-and-forget)
```

## 4. 법령 도구 (자체 구현 Tool Use)

### 설계 원칙

- **MCP 미사용** — Anthropic 단독 LLM 라우팅이므로 표준 프로토콜 가치가 낮다. `lib/law/`에 직접 구현.
- 도구 정의는 **Anthropic.Tool schema**로 작성, **Claude tool runner**가 자동 루프 처리.
- 모든 도구 실행은 **`law_cache` 테이블 캐싱** + **`query_log.cited_law_refs`에 호출 기록**.

### 17개 도구 후보 (Korean Law MCP v4.0 fork 참고)

| # | 도구 | 입력 | 출력 |
|---|---|---|---|
| 1 | `search_law` | `query`, `type` | 법령 목록 (ID, 명, 시행일) |
| 2 | `get_law_article` | `law_id`, `article` | 조항 본문 |
| 3 | `get_law_history` | `law_id` | 개정 이력 |
| 4 | `search_decree` | `query` | 시행령 검색 |
| 5 | `search_rule` | `query` | 시행규칙 검색 |
| 6 | `search_precedent` | `query`, `court` | 판례 검색 |
| 7 | `get_precedent` | `case_id` | 판례 본문 |
| 8 | `search_constitutional_court` | `query` | 헌재 결정 검색 |
| 9 | `search_interpretation` | `query` | 법령해석례 검색 |
| 10 | `search_ordinance` | `query`, `region` | 자치법규 검색 |
| 11 | `search_administrative_rule` | `query` | 행정규칙 검색 |
| 12 | `verify_citation` ★ | `law_name`, `article`, `quoted_text` | 인용 정확성 검증 결과 |
| 13 | `impact_map` | `law_id`, `article` | 영향받는 조문 그래프 |
| 14 | `time_travel` | `law_id`, `date1`, `date2` | 시점 간 diff |
| 15 | `find_related_laws` | `law_id` | 연관 법령 추천 |
| 16 | `get_definition` | `term` | 법령용어 정의 |
| 17 | `action_plan` | `situation` | 시민 5단계 실행 가이드 |

★ `verify_citation` — **환각 방지 핵심 도구**. 본 모듈의 가장 큰 가치.

### 도구 우선순위 (PoC 구현 순서)

1. **MVP (5월말)**: `search_law`, `get_law_article`, `verify_citation` — 어드바이저 기본 동작
2. **확장 (6월)**: `search_precedent`, `get_precedent`, `get_law_history`, `search_decree`, `search_rule`
3. **고도화 (7월)**: 나머지 9개

## 5. 인용 검증 (`verify_citation`) 상세

LLM 답변에 등장한 법령 인용을 법제처 DB와 교차 검증.

### 입력

```json
{
  "law_name":    "근로기준법",
  "article":     "제53조",
  "quoted_text": "사용자는 1주 12시간을 한도로 연장할 수 있다."
}
```

### 알고리즘

1. `search_law(law_name)`로 법령 ID 조회 (`law_cache` 우선)
2. `get_law_article(law_id, article)`로 조항 원문 조회
3. 원문 vs `quoted_text` 텍스트 유사도 계산
   - 1차: 정규화 후 정확 일치
   - 2차: 임베딩 코사인 유사도 (Cohere)
4. 결과 반환

### 출력

```json
{
  "verified": true,
  "law_id":   "12345",
  "article":  "제53조",
  "official_text": "사용자는 1주 12시간을 한도로 ...",
  "similarity": 0.97,
  "effective_date": "2024-05-17"
}
```

### Claude가 활용하는 패턴

답변 생성 중 인용을 만들 때 자동으로 `verify_citation` 호출 → 검증 실패 시 답변 수정 또는 "확인되지 않음" 명시.

## 6. 시스템 프롬프트

```
당신은 ICT기금 규정·법령 어드바이저입니다.

[원칙]
- 제공된 <context>의 내부 규정·지침·해석사례와 법령·판례만 근거로 답변합니다.
- 컨텍스트에 없는 사실은 추측하지 말고 "확인된 자료에 없습니다"라고 명시합니다.
- 모든 인용에 출처(법령명·조항·내부문서번호)를 반드시 표기합니다.
- 인용을 사용할 때는 verify_citation 도구로 검증을 시도하세요.
- 답변 끝에 "근거" 섹션을 두고 번호와 출처를 나열합니다.

[답변 형식]
1. 결론 (2~3줄)
2. 적용 조항·규정 요약 (인용 포함)
3. 적용 시 유의사항
4. 근거 목록
```

→ `cache_control: { type: "ephemeral" }` 적용으로 프롬프트 캐시.

## 7. 사용자 로그 분석 (보고서 명시 기능)

`query_log` 적재 데이터로 분석:

- **FAQ 자동 생성** — 유사 질의 클러스터링, 빈도 상위 추천
- **질문 트렌드** — 시기별·분야별 분포
- **답변 정확도** — `citation_verified` 비율, `feedback` 평균
- **추천 질문** — 사용자 컨텍스트 기반 다음 질문 제안

→ 관리자 페이지 `(admin)/logs/page.tsx`에서 시각화.

## 8. 평가 셋

PoC 종료(7월말) 전 다음 평가:

| 지표 | 목표 |
|---|---|
| Retrieval Recall@8 | ≥ 0.85 |
| Citation Verification 통과율 | ≥ 0.95 |
| 사용자 만족도 (5점 척도) | ≥ 4.0 |
| 평균 응답 시간 (TTFT) | ≤ 3초 |
| 평균 응답 완료 시간 | ≤ 15초 |

평가 셋: ICT기금 운영팀이 작성한 골든 Q&A 50~100건.

만족도가 4.0 미만일 경우, **Opus 4.7 라우팅 추가** 또는 **임베딩 모델 교체** 검토.

## 9. 향후 확장

- 멀티턴 대화 (현재 단일 질문 응답)
- 사용자 컨텍스트 기반 답변 (소속·직무·과거 질의 이력)
- 답변에 대한 피드백 수집 UI
- 법령 변경 알림 (관심 법령 변경 시 push)
