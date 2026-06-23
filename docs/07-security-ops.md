# 보안 · 운영 · 비용

> **한 줄 요약**: 이 서비스는 **불특정 공개 이용자**가 로그인 없이 쓰는 공개 서비스입니다. 봇·악용 방지는 Turnstile 봇 게이트(토글/키 기반, 기본 OFF)와 IP 레이트리밋(기본 OFF)으로 통제합니다. 모든 외부 API 호출은 서버(Vercel 함수)에서만 일어나고, 색인 기능은 외부 사용자에게 절대 열지 않습니다. 임베딩은 OpenAI, 재정렬은 Cohere, 답변 생성은 Anthropic Claude, 법령 조회는 법제처 OpenAPI를 직접 호출하는 자체 구현 도구(`lib/law/`)를 씁니다.

---

## 0. 용어 한 줄 정의

- **임베딩(embedding)**: 문장을 숫자 벡터로 바꿔 의미가 비슷한 문서를 찾게 해 주는 기술.
- **재정렬(rerank)**: 1차로 찾은 후보 문서들을 질문에 더 잘 맞는 순서로 다시 줄 세우는 단계.
- **RLS(Row Level Security)**: 데이터베이스가 "이 사람은 이 행만 볼 수 있다"를 행 단위로 강제하는 기능.
- **레이트리밋(rate limit)**: 일정 시간에 허용하는 요청 횟수 상한.
- **법령 도구**: 법제처 국가법령정보 공동활용 OpenAPI를 직접 호출하는 자체 구현 도구(`lib/law/`). 개발 환경의 korean-law MCP는 Vercel 서버리스에 상주할 수 없어 동일 기능을 자체 함수로 구현했고, 질의는 제3자 MCP 경유 없이 법제처로만 나간다(보안상 경로가 단순).

---

## 1. 이용 대상과 접근 원칙 (가장 중요)

이 서비스는 **불특정 공개 이용자**가 로그인 없이 접근할 수 있습니다.

| 원칙 | 내용 |
|---|---|
| 공개 접근 | 로그인·계정 없이 어드바이저 챗봇 사용 가능. |
| 봇·악용 방지 | Turnstile 봇 게이트(토글/키 기반, 기본 OFF) + IP 레이트리밋·일일 캡(기본 OFF). 키·토글 부재 시 게이트 없음(기존 동작 유지). |
| 색인은 외부 차단 | `/api/ingest`(문서 색인)는 **외부 사용자 절대 차단**. `INGEST_SECRET` 헤더 인증 필수(미설정 시 전체 차단). |
| 서버에서만 외부 호출 | 임베딩·재정렬·LLM·법령 API는 모두 Vercel 함수 안에서만 호출. 클라이언트는 키를 모름. |
| 내부 오류 비노출 | DB·함수 오류 원문을 사용자 화면에 보여주지 않음. 서버 로그에만 남김. |

---

## 2. 데이터 흐름 다이어그램 (보안 검토용)

```
                        ┌──────────────────────────┐
                        │  공개 이용자 (로그인 없음) │
                        └──────────┬───────────────┘
                                   │ HTTPS
                                   ▼
            ┌────────────────────────────────────────────┐
            │      Vercel (Next.js API routes)            │
            │                                             │
            │  - Turnstile 봇 게이트 (토글/키 기반, 기본 OFF) │
            │  - 입력 검증 (zod) + 입력 길이·턴 수 제한   │
            │  - IP 레이트리밋 · 일일 캡 (기본 OFF)       │
            │  - 외부 API 호출 (server only)              │
            │  - 에러 메시지 일반화 (원문은 서버 로그)    │
            └──┬──────────┬──────────┬──────────┬─────────┘
               │          │          │          │
               ▼          ▼          ▼          ▼
      ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐
      │ Supabase │ │ OpenAI   │ │  Cohere  │ │  법제처      │
      │ Postgres │ │ 임베딩    │ │ 재정렬    │ │ OpenAPI     │
      │  (RLS)   │ │(3-small) │ │(rerank   │ │ 직접호출    │
      │          │ │ 1024차원  │ │ -v4.0)   │ │ (자체구현)  │
      └──────────┘ └──────────┘ └──────────┘ └─────────────┘
                        │
                        ▼  (답변 생성)
                  ┌──────────────┐
                  │  Anthropic   │
                  │ Claude       │
                  │ sonnet-4-6   │
                  └──────────────┘
```

→ 모든 외부 API 호출은 **Vercel 함수 내부에서만** 발생합니다. 클라이언트는 외부 API를 직접 호출하지 않으며, 아래 키는 모두 **서버 환경변수**입니다.

| 환경변수 | 용도 |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 서버측 DB 쓰기 |
| `OPENAI_API_KEY` | **임베딩** (`text-embedding-3-small`, 1024차원) |
| `COHERE_API_KEY` | **재정렬** (`rerank-v3.5`) |
| `ANTHROPIC_API_KEY` | 답변 **LLM** (`claude-sonnet-4-6`) |
| `LAW_GO_KR_API_KEY` | 법제처 OpenAPI(OC 인증값) — 자체 구현 법령 도구 `lib/law/` 직접 호출 |

---

## 3. 보안성 검토 대응

| 검토 항목 | 답변 |
|---|---|
| 외부 클라우드 사용 근거 | 처리 데이터가 공개 가능 자료. Vercel·Supabase는 ISO 27001·SOC 2 인증 |
| 외부 LLM API 사용 근거 | 답변 생성용. 입력은 공개 가능 자료. Anthropic API는 데이터 학습 미사용(Zero-data-retention 옵션 검토) |
| 임베딩·재정렬 API 사용 근거 | 임베딩(OpenAI)은 문서 검색용 벡터 생성, 재정렬(Cohere)은 검색 결과 순서 보정용. 둘 다 공개 자료만 전송 |
| 키 관리 | Vercel 환경변수 + Supabase Vault. 클라이언트 노출 0 |
| 접근 통제 | 공개 접근. 봇·악용은 Turnstile 봇 게이트 + IP 레이트리밋(각 기본 OFF, 토글/키 기반). 색인 API는 INGEST_SECRET 헤더 인증 필수. |
| 채팅·색인 보호 | 채팅은 Turnstile·레이트리밋(기본 OFF) + 입력 캡, 색인 API는 외부 차단(INGEST_SECRET 필수) |
| 감사 로그 | `query_log`, `crawl_runs` 모두 적재 (관리자 화면에서 조회) |
| 백업·복구 | Supabase 자동 백업 (Pro: 7일 PITR) |

---

## 4. 인증·인가

### 4.1 사용자 분류

| 역할 | 권한 |
|---|---|
| `anonymous` | 로그인 없이 어드바이저 챗봇 사용 가능(공개 접근). |
| `authenticated` | 로그인한 관리자 — 어드바이저 사용 + 자기 `query_log` 열람 |
| `admin` | 관리자 — 모든 페이지, 크롤링 결과 관리, 채팅 로그·통계 조회 |

→ 관리자 계정만 Supabase Auth `app_metadata.role` 활용 (보안: 사용자가 직접 바꿀 수 있는 `user_metadata` 미사용).

### 4.2 RLS 정책 패턴

```sql
-- 외부 기관 담당자는 자기 로그만 조회
create policy "query_log_self" on public.query_log
  for select to authenticated
  using (auth.uid() = user_id);

-- 관리자는 모든 로그 조회
create policy "query_log_admin" on public.query_log
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
```

### 4.3 채팅 API 게이트 (`/api/chat`) — 골격 구현 완료

> **구현 상태(골격 적용)**: 입력 캡(MAX_TURNS/MAX_CONTENT_CHARS)·에러 일반화·Turnstile 봇 게이트·IP 레이트리밋 모두 코드에 포함. 게이트는 토글/키 기반으로 기본 OFF — 키를 채워야 활성화됨.

- **봇 게이트**: Turnstile 검증 (`TURNSTILE_ENABLED=true` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` 설정 시 활성). 미설정 시 게이트 없음(기존 동작).
- **IP 레이트리밋**: 분당 상한(`RATE_LIMIT_PER_MIN`) + 일일 캡(`RATE_LIMIT_DAILY_CAP`). `RATE_LIMIT_ENABLED=true` 설정 시 활성, 기본 OFF. ※ Supabase `rate_limit_counter` 테이블 필요.
- **입력 제한**: 질문 길이 상한(`MAX_CONTENT_CHARS=8000`), 대화 턴 수 상한(`MAX_TURNS=30`) — 기본값으로 항상 적용.
- **I3 query_log IP 기반 적재**: 미구현·후속. 익명 공개라 user_id 대신 IP/세션 기반으로 별도 DB PR 진행.
- **I4 RLS 요청경로 준수(service_role → anon 전환)**: 미구현·후속. 익명 공개에서 우선순위 낮음, 별도 폴리시 작업.

### 4.4 색인 API 잠금 (`/api/ingest`) — 적용 완료

> **구현 상태(적용)**: `INGEST_SECRET` 환경변수 기반 헤더 인증 게이트 적용 완료.

- `INGEST_SECRET` 미설정 시 `/api/ingest` 전체 차단(403).
- 설정 시 요청 헤더 `x-ingest-secret` 값 검증. 불일치 시 401.
- 적재 스크립트는 `x-ingest-secret` 헤더로 전송.
- 외부 사용자에게는 어떤 경우에도 색인 경로를 열지 않습니다.

---

## 5. 외부 호출 안정성 (타임아웃·재시도·비용 가드)

외부 호출(임베딩·재정렬·LLM·법령 API)은 느려지거나 실패할 수 있으므로 아래를 적용합니다.

| 항목 | 정책 | 상태 |
|---|---|---|
| 타임아웃 | 각 외부 호출에 타임아웃 지정. 초과 시 사용자에게 일반화된 안내. | 부분 적용 |
| 재시도(백오프) | 일시 오류(5xx·타임아웃)는 지수 백오프로 제한된 횟수만 재시도. | 후속 |
| 비용 가드 | 일·기관·사용자별 호출/토큰 상한. 초과 시 차단 + 관리자 알림. | 후속 |
| **에러 일반화** | 외부/내부 오류 원문은 서버 로그에만. 사용자에겐 "일시 오류" 수준 메시지. | **적용 완료** |

---

## 6. 관리자 채팅 로그 · 감사

### 6.1 `query_log` 적재 항목

실제 컬럼:

| 컬럼 | 설명 |
|---|---|
| `query` / `answer` | 질문 / 답변 |
| `retrieved_doc_ids` | 검색된 문서 ID 목록 |
| `cited_law_refs` | 인용한 법령(법·조문·일자) |
| `citation_verified` | 인용 검증 통과 여부 |
| `llm_model` | 답변에 쓴 모델(`claude-sonnet-4-6`) |
| `retrieval_ms` / `rerank_ms` / `llm_ms` / `total_ms` | 단계별·전체 지연(ms) |
| `tokens_in` / `tokens_out` | 입력/출력 토큰 |
| `feedback` | 사용자 피드백 |
| `user_id` / `created_at` | 작성자 / 시각 |

**운영용 추가 항목**(분석을 위해 별도 적재/연결):

| 항목 | 설명 |
|---|---|
| 소속 기관 | 사용자의 소속 외부 기관(기관별 사용량 집계용) |
| 분기 결과 | 질의가 어느 처리 경로(법령/사업/일반)로 분기됐는지 |
| 관련도 점수 | 재정렬 후 상위 문서의 관련도 점수 |

### 6.2 관리자 화면

관리자(`admin`) 권한만 접근 가능.

- **통계**: 일·주별 질의 수, 기관별 사용량, 분기 비율, 평균 지연, 토큰·비용.
- **개별 대화 세부 조회**: 질문·답변·인용·검증 결과·단계별 지연.

---

## 7. 캐싱 전략

### 7.1 `law_cache` (법제처 응답)

| 도구 | TTL |
|---|---|
| `search_law`, `get_law_text` | 24시간 (법령은 자주 안 바뀜) |
| `search_decisions` | 24시간 |
| `verify_citations` | 7일 (인용 검증 결과) |

### 7.2 Prompt Caching (Anthropic)

- 시스템 프롬프트(`SYSTEM_PROMPT`)에 `cache_control: { type: "ephemeral" }`
- 짧은 TTL → 활발한 사용 시 입력 토큰 비용 절감
- 도구 정의는 캐싱 prefix에 포함(변경 빈도 낮음)

### 7.3 Edge Caching

- `/api/health` 등 인증 불필요한 정적 응답만 Vercel Edge Cache
- 인증 필요 라우트(`/api/chat` 등)는 `no-store`

---

## 8. 비용 추정 (운영 시 월 기준)

가정: 어드바이저 일 100건 질의 (월 3,000건)

| 항목 | 단가 | 월 비용 |
|---|---|---|
| Vercel Pro | $20 | $20 |
| Supabase Pro | $25 | $25 |
| Anthropic Claude `sonnet-4-6` | $3/M input, $15/M output | $30~60 |
| **OpenAI 임베딩** (`text-embedding-3-small`, 초기 1회 100K 청크) | $0.02/M tokens | 초기 약 $2, 운영 미미 |
| Cohere 재정렬 (`rerank-v3.5`, 3K queries) | 쿼리 단가 | $5~10 |
| 법제처 OpenAPI (자체 구현 도구 직접 호출) | 무료 | $0 |
| **합계 (운영 정상화 후)** | | **약 $80~120/월** |

PoC 단계는 사용량이 적어 무료 티어 + Pro 구독 비용 정도.
크롤러 본격 가동 시 분류용 LLM 비용 추가($20~40/월 예상).

> 임베딩은 OpenAI, 재정렬은 Cohere입니다. 둘은 **별개 단계**이며 서로 무관합니다.

---

## 9. 가용성 · 모니터링

### 모니터링 항목

| 항목 | 도구 |
|---|---|
| Vercel 함수 메트릭 | Vercel Analytics + Logs |
| Supabase Postgres | Supabase Dashboard |
| API 응답시간 | `query_log.total_ms` |
| 크롤링 성공률 | `crawl_runs.status` 집계 |
| 인용 검증율 | `query_log.citation_verified` |
| 레이트리밋·비용 가드 발동 | 서버 로그 + 관리자 알림 |
| 오류율 | Vercel error logs + Sentry (도입 검토) |

### 장애 대응

- **법제처 API 다운**: `law_cache`로 fallback, "법제처 일시 장애" 안내.
- **임베딩/재정렬 API 다운**: 타임아웃·재시도 후에도 실패하면 일반화된 안내.
- **Anthropic API 다운**: 사용자 안내 + 제한적 자동 재시도.
- **Supabase 다운**: 시스템 전체 장애 — 다중 리전은 본 운영 단계 검토.

---

## 10. 데이터 보존 · 삭제

| 데이터 | 보존 기간 | 삭제 방법 |
|---|---|---|
| `query_log` | 1년 (집계 후 익명화) | Cron으로 user_id NULL 처리 |
| `crawl_runs` | 6개월 | Cron 삭제 |
| `law_cache` | TTL 만료 시 | `ttl_at < now()` 삭제 |
| 사업계획서 원본 (Storage) | 분석 후 30일 | 자동 삭제 정책 |

---

## 11. 오픈 전 보안 하드닝 체크리스트

외부 기관에 오픈하기 전 아래 항목을 단계별로 점검합니다.

### Critical (오픈 전 반드시)

- [x] **`/api/ingest` 보호**: `INGEST_SECRET` 헤더 인증 게이트 적용. 미설정 시 전체 차단.
- [x] **봇 게이트**: Turnstile 봇 게이트 골격 구현(토글/키 기반, 기본 OFF — `TURNSTILE_ENABLED` + 두 키 설정 시 활성).
- [x] **레이트리밋**: IP 기반 분당·일일 캡 골격 구현(기본 OFF — `RATE_LIMIT_ENABLED=true` 설정 시 활성). ※ 임계 튜닝·만료 row 정리는 후속.
- [x] **에러 일반화**: DB·함수 오류 원문을 클라이언트에 노출하지 않음(서버 로그만). 적용 완료.
- [x] **입력 제한**: 질문 길이(`MAX_CONTENT_CHARS`)·대화 턴 수(`MAX_TURNS`) 상한. 적용 완료.

### High (오픈 전 권장)

- [ ] **타임아웃·재시도(백오프)**: 모든 외부 호출에 적용.
- [ ] **비용 가드**: 일·기관·사용자별 호출/토큰 상한 + 초과 시 차단·알림.
- [ ] **관리자 로그·통계**: `query_log` 적재 확인, 운영용 추가 항목(소속 기관·분기·관련도) 연결, 관리자 화면 권한 검증.
- [ ] **RLS 점검**: 모든 사용자 데이터 테이블에 self/admin 정책 존재 확인.

### Medium (안정화 단계)

- [ ] **SDK 타입 정리**: 외부 SDK 응답 타입을 명시해 런타임 오류 예방.
- [ ] **보안 헤더**: `Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport-Security` 등.
- [ ] **`/api/health` 확장**: DB·외부 API 연결 상태까지 점검하도록 확장.
- [ ] **최소 테스트 · CI**: 핵심 경로(인증·색인 차단·레이트리밋) 테스트 + CI에서 자동 실행.

---

## 12. 알려진 리스크 · 완화

| 리스크 | 가능성 | 영향 | 완화 |
|---|---|---|---|
| 색인 API 외부 노출 | 중 | 고 | 외부 차단(관리자 전용/스크립트 전용) — 오픈 전 Critical 항목 |
| 외부 API 비용 폭증 | 중 | 중 | 비용 가드 + 레이트리밋 + 모니터링 |
| 가격 인상(OpenAI/Cohere/Anthropic) | 저 | 중 | 분기별 재평가, 모델 교체 가능성 |
| 법제처 API 정책 변경 | 저 | 고 | `law_cache` fallback, 대체 경로 검토 |
| LLM 환각으로 잘못된 인용 | 중 | 고 | `verify_citations` 강제, 미통과 시 답변 수정 |
| RLS 정책 누락 | 저 | 고 | 마이그레이션 PR 리뷰 체크리스트 |
| 내부 오류 메시지 노출 | 중 | 중 | 에러 일반화 + 서버 로그 분리 |

---

## 13. 외부 의존성 · 라이센스

| 외부 패키지 | 용도 | 라이센스 |
|---|---|---|
| Next.js | 웹/API 프레임워크 | MIT |
| @supabase/supabase-js | DB·Auth 클라이언트 | MIT |
| openai | **임베딩** (`text-embedding-3-small`) | MIT/Apache-2.0 계열 |
| cohere-ai | **재정렬** (`rerank-v3.5`) | MIT |
| @anthropic-ai/sdk | 답변 LLM (`claude-sonnet-4-6`) | MIT |
| cheerio | 크롤링 HTML 파싱 | MIT |
| zod | 입력 검증 | MIT |

→ 신규 의존성 추가 시 라이센스 확인 필수.
