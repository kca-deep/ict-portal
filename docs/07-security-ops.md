# 보안 · 운영 · 비용

> **한 줄 요약**: 이 서비스는 **로그인 없이(no-login)** 쓰는 규정·법령 어드바이저입니다. 사용자 인증이 없으므로 공개 챗 엔드포인트(`/api/chat`)의 접근·비용 통제는 **봇차단(Vercel BotID/WAF) + 레이트리밋(Upstash) + 비용가드(일일 토큰 예산·이메일 경고)**로 합니다. 모든 외부 API 호출은 서버(Vercel 함수)에서만 일어나고, 색인(`/api/ingest`)은 시크릿으로 잠그며, 관리자 화면(`/admin`)만 아이디+비밀번호+서명 쿠키로 보호합니다. 임베딩은 OpenAI, 재정렬은 Cohere, 답변 생성은 Anthropic Claude, 법령 조회는 법제처 OpenAPI를 직접 호출하는 자체 구현 도구(`lib/law/`)를 씁니다.

> **인증 모델 결정(2026-07)**: 초기 기획의 "로그인 필수(Supabase Auth·RLS 역할 분리)"는 **폐기**했습니다. 현재는 **no-login**이며 사용자 식별은 **요청 IP**로만 합니다. 사용자 계정·초대·승인·RLS self/admin 정책은 쓰지 않습니다. RLS 는 여전히 모든 테이블에 enable 하되, 데이터 접근은 **서버 전용 `service_role`**로만 합니다.

---

## 0. 용어 한 줄 정의

- **임베딩(embedding)**: 문장을 숫자 벡터로 바꿔 의미가 비슷한 문서를 찾게 해 주는 기술.
- **재정렬(rerank)**: 1차로 찾은 후보 문서들을 질문에 더 잘 맞는 순서로 다시 줄 세우는 단계.
- **RLS(Row Level Security)**: DB가 행 단위로 접근을 강제하는 기능. 본 서비스는 사용자 인증이 없어 **모든 테이블 RLS enable + service_role 만 접근**(공개 anon 접근 없음).
- **레이트리밋(rate limit)**: 일정 시간에 허용하는 요청 횟수 상한. 저장소는 Upstash Redis.
- **비용가드(cost guard)**: 실제 LLM **토큰 소비**를 IP·전역 일일 예산으로 통제하고, 초과 시 차단·경고.
- **BotID**: Vercel 봇 탐지. 클라이언트 신호를 수집해 서버에서 자동화 트래픽을 거른다.
- **법령 도구**: 법제처 국가법령정보 OpenAPI를 직접 호출하는 자체 구현 도구(`lib/law/`).

---

## 1. 이용 대상과 접근 원칙 (가장 중요)

이용 대상은 **ICT기금 외부 기관 담당자**지만, 서비스는 **로그인 없이(no-login)** 접근합니다. 사용자 인증이 없는 대신 아래 방어선으로 남용·비용을 통제합니다.

| 원칙 | 내용 |
|---|---|
| no-login | 사용자 로그인·회원가입·계정 없음. 식별은 **요청 IP**(감사 로그·레이트리밋 키). |
| 봇차단 | `/api/chat` 은 **Vercel BotID** 서버 검증(`checkBotId`) + WAF 로 자동화 트래픽 차단. |
| 레이트리밋 | IP 분당 + IP 일일 + 전역 일일 호출 상한(Upstash). 프로덕션 기본 활성. |
| 비용가드 | IP·전역 **일일 토큰 예산** 초과 시 429 + 임계치 도달 시 관리자 이메일 경고. |
| 색인은 외부 차단 | `/api/ingest` 는 `INGEST_SECRET` 헤더 필수. 미설정·불일치 시 404 로 은닉(존재 은닉). |
| 관리자만 인증 | `/admin` 은 아이디+비밀번호 + 서명 `__Host-` httpOnly 쿠키 + 미들웨어 게이트. |
| 서버에서만 외부 호출 | 임베딩·재정렬·LLM·법령 API는 모두 Vercel 함수 안에서만. 클라이언트는 키를 모름. |
| 내부 오류 비노출 | DB·함수 오류 원문을 사용자에게 노출하지 않음(일반화 문구만, 원문은 서버 로그). |

---

## 2. 데이터 흐름 다이어그램 (보안 검토용)

```
                        ┌──────────────────────────┐
                        │   이용자 (로그인 없음)     │
                        └──────────┬───────────────┘
                                   │ HTTPS (+ BotID 클라이언트 신호)
                                   ▼
            ┌────────────────────────────────────────────┐
            │      Vercel (Next.js API routes)            │
            │  진입 가드(순서):                            │
            │   1) BotID 봇차단 (checkBotId)              │
            │   2) 레이트리밋 (IP/분·IP/일·전역/일)       │
            │   3) 비용가드 (일일 토큰 예산)              │
            │   4) 입력 검증·길이·턴 수 캡                │
            │  - 외부 API 호출 (server only)              │
            │  - 에러 일반화 (원문은 서버 로그)           │
            │  - 응답 후 소비 토큰 누적(예산·경고)        │
            └──┬─────────┬─────────┬─────────┬─────┬──────┘
               │         │         │         │     │
               ▼         ▼         ▼         ▼     ▼
      ┌──────────┐ ┌────────┐ ┌────────┐ ┌───────┐ ┌──────────┐
      │ Supabase │ │ OpenAI │ │ Cohere │ │ 법제처 │ │ Upstash  │
      │ Postgres │ │ 임베딩  │ │ 재정렬  │ │OpenAPI│ │ Redis    │
      │ (RLS·svc)│ │(3-small)│ │(v3.5) │ │직접호출│ │(리밋·비용)│
      └──────────┘ └────────┘ └────────┘ └───────┘ └──────────┘
                        │
                        ▼  (답변 생성)
                  ┌──────────────┐
                  │  Anthropic   │
                  │ Claude       │
                  │ sonnet-4-6   │
                  └──────────────┘
```

→ 모든 외부 API 호출은 **Vercel 함수 내부에서만** 발생합니다. 아래 키는 모두 **서버 환경변수**입니다.

| 환경변수 | 용도 |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 서버측 DB 읽기/쓰기(RLS 우회, 서버 전용) |
| `OPENAI_API_KEY` | **임베딩** (`text-embedding-3-small`, 1024차원) |
| `COHERE_API_KEY` | **재정렬** (`rerank-v3.5`) |
| `ANTHROPIC_API_KEY` | 답변 **LLM** (`claude-sonnet-4-6`) |
| `LAW_GO_KR_API_KEY` | 법제처 OpenAPI(OC 인증값) — 자체 구현 법령 도구 `lib/law/` |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | 레이트리밋·비용가드 저장소(프로덕션 필수) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 관리자 로그인(프로덕션 필수) |
| `ADMIN_SESSION_SECRET` | 관리자 세션 서명키(선택 — 미설정 시 `ADMIN_PASSWORD` 폴백) |
| `INGEST_SECRET` | 색인 API 잠금(미설정 시 `/api/ingest` 항상 차단) |
| `RESEND_API_KEY` / `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO` | 비용·남용 경고 이메일(선택) |

---

## 3. 보안성 검토 대응

| 검토 항목 | 답변 |
|---|---|
| 외부 클라우드 사용 근거 | 처리 데이터가 공개 가능 자료. Vercel·Supabase·Upstash는 SOC 2 등 인증 |
| 외부 LLM API 사용 근거 | 답변 생성용. 입력은 공개 가능 자료. Anthropic API 데이터 학습 미사용 |
| 임베딩·재정렬 API 사용 근거 | 임베딩(OpenAI) 검색 벡터, 재정렬(Cohere) 순서 보정. 둘 다 공개 자료만 전송 |
| 키 관리 | Vercel 환경변수. 클라이언트 노출 0. 관리자 세션은 서명 httpOnly 쿠키 |
| 접근 통제(no-login) | 사용자 인증 없음. 대신 BotID + 레이트리밋 + 비용가드로 남용·비용 통제. 관리자만 비번+쿠키 |
| 채팅·색인 보호 | 채팅: 봇차단+레이트리밋+비용가드+입력캡. 색인: `INGEST_SECRET` 잠금(외부 404 은닉) |
| 전송 보안 헤더 | HSTS·X-Frame-Options:DENY·nosniff·Referrer-Policy·Permissions-Policy + **nonce 기반 CSP** |
| 감사 로그 | `query_log`(IP 기준), `crawl_runs` 적재 (관리자 화면 조회) |
| 백업·복구 | Supabase 자동 백업 (Pro: 7일 PITR) |

---

## 4. 인증·인가 (no-login)

### 4.1 접근 주체

| 주체 | 접근 |
|---|---|
| 이용자(익명) | 로그인 없이 `/`(챗) 사용. IP로 식별·통제. `/admin`·`/api/admin` 접근 불가 |
| 관리자 | `/admin` 로그인(아이디+비밀번호) 후 서명 쿠키로 대시보드·로그 조회 |

> 사용자 RLS self/admin 정책, Supabase Auth, `app_metadata.role` 은 **쓰지 않습니다.** DB 접근은 전부 서버의 `service_role` 로만 하고, 브라우저에는 service_role 키가 나가지 않습니다.

### 4.2 관리자 인증 (`/admin`)

- **자격증명**: `ADMIN_USERNAME` + `ADMIN_PASSWORD`. 로그인 시 아이디·비밀번호를 각각 **상수시간 비교**(`timingSafeEqual`) 후 AND. 어느 필드가 틀렸는지·계정 존재를 드러내지 않는 동일 `401`.
- **세션 쿠키**: 맞으면 `${exp}.${HMAC-SHA256}` 서명 토큰을 발급(`lib/admin-auth.ts`). 쿠키는 **httpOnly + sameSite=lax + Secure(프로덕션) + `__Host-` 프리픽스(프로덕션)**. 서명키는 `ADMIN_SESSION_SECRET`(없으면 `ADMIN_PASSWORD` 폴백). 만료 8시간.
- **문지기(미들웨어)**: `/admin/*`(로그인 폼 제외) 진입 시 쿠키 서명·만료 검증. 실패 시 로그인으로 리다이렉트. `/api/admin/*` 라우트는 핸들러에서 동일 쿠키를 직접 검증.
- **브루트포스 억제**: 로그인 시도 IP당 10분 10회(Upstash). 초과 시 429.

### 4.3 채팅 엔드포인트 가드 (`/api/chat`) — 진입 순서

1. **BotID**: `checkBotId()` 로 자동화 트래픽 차단(403). 클라이언트 신호는 루트 레이아웃의 `<BotIdClient>` 가 수집.
2. **레이트리밋**(Upstash): IP 분당(슬라이딩) + IP 일일 + 전역 일일. 초과 시 429. 프로덕션은 저장소 오류 시 **fail-closed**(비용 보호 우선).
3. **비용가드**: 오늘 IP·전역 **일일 토큰 예산**을 이미 소진했으면 429. 응답 후 소비 토큰(입력+출력)을 누적.
4. **입력 캡**: 대화 턴 수(`MAX_TURNS`)·메시지 길이(`MAX_CONTENT_CHARS`) 상한.

### 4.4 색인 API 잠금 (`/api/ingest`)

- `INGEST_SECRET` **미설정 시 항상 403**. 설정 시 `x-ingest-secret` 헤더 일치해야 통과.
- 미들웨어는 헤더 불일치를 **없는 경로로 rewrite** 해 진짜 404와 동일하게 응답(401/403 신호·엔드포인트 존재를 은닉).

---

## 5. 비용 가드 · 외부 호출 안정성

### 5.1 비용 가드(토큰 예산)

| 항목 | 정책 |
|---|---|
| IP 일일 토큰 | `COST_IP_DAILY_TOKENS`(기본 200K). 초과 시 해당 IP 그날 차단. |
| 전역 일일 토큰 | `COST_GLOBAL_DAILY_TOKENS`(기본 5M). 초과 시 전체 차단. |
| 경고 | 예산 대비 `ALERT_COST_THRESHOLD`(기본 80%) 도달 시 관리자 이메일(하루 1회, Redis 플래그로 디듈). |
| 롤오버 | KST 자정 경계 일일 버킷(`kstDayKey`). 카운터 TTL 2일. |
| 저장소 장애 | 프로덕션 fail-closed(차단), 로컬 통과. |

### 5.2 외부 호출 안정성

| 항목 | 정책 |
|---|---|
| 타임아웃 | 각 외부 호출에 타임아웃. 초과 시 일반화 안내. |
| 재시도 | 일시 오류(5xx·타임아웃)는 제한적 재시도. |
| 에러 일반화 | 외부/내부 오류 원문은 서버 로그에만. 사용자에겐 "일시 오류" 수준 메시지(`/api/chat`·`/api/health` 적용). |
| 폴백 | 법제처 다운 시 `law_cache` fallback. 재정렬 실패 시 규정 RRF 순 폴백. |

---

## 6. 관리자 채팅 로그 · 감사

### 6.1 `query_log` 주요 항목

`query`/`answer`, `ip`(사용자 식별), `route`(unified/regulation/law/out_of_scope), `retrieved_doc_ids`, `law_refs`/`cited_law_refs`, `citation_verified`/`has_hallucination`, `llm_model`, 단계별 지연(`retrieval_ms`/`rerank_ms`/`llm_ms`/`ttft_ms`/`total_ms`), `tokens_in`/`tokens_out`, `feedback`, `error_code`, `created_at`.

> 사용자 식별은 `user_id` 가 아니라 **`ip`** 입니다(no-login). 소속 기관 개념은 없습니다.

### 6.2 관리자 화면(`/admin`)

- **요약**: 사용량·이용자(고유 IP)·이용률, 분기 비율, 환각·오류·만족도, 평균 지연, 쉬는 날/저녁심야 사용 비중.
- **로그 표 + 상세**: 시각·IP·질문·분기·관련도·환각·지연·토큰, 행 클릭 시 전문·인용 verdict.
- 데이터는 전부 서버에서 `service_role` 로만 읽고 브라우저로 키가 나가지 않음.

---

## 7. 캐싱 전략

### 7.1 `law_cache` (법제처 응답)

| 도구 | TTL |
|---|---|
| `search_law`, `get_law_text`, `search_decisions` | 24시간 |
| `verify_citations` | 7일 |

### 7.2 Prompt Caching (Anthropic)

- 시스템 프롬프트·도구 정의에 `cache_control: ephemeral` 로 입력 토큰 비용 절감.

### 7.3 Edge/응답 캐싱

- `/api/health` 등 비인증 정적 응답만 짧게 캐시. `/api/chat` 등은 `no-store`.

---

## 8. 비용 추정 (운영 시 월 기준)

가정: 어드바이저 일 100건 질의 (월 3,000건)

| 항목 | 단가 | 월 비용 |
|---|---|---|
| Vercel Pro | $20 | $20 |
| Supabase Pro | $25 | $25 |
| Upstash Redis | 사용량(소량) | ~$0–5 |
| Anthropic Claude `sonnet-4-6` | $3/M in, $15/M out | $30~60 |
| OpenAI 임베딩(초기 색인) | $0.02/M | 초기 ~$2, 운영 미미 |
| Cohere 재정렬(`rerank-v3.5`) | 쿼리 단가 | $5~10 |
| Resend(경고 이메일) | 무료 티어 | $0 |
| 법제처 OpenAPI | 무료 | $0 |
| **합계(정상화 후)** | | **약 $80~130/월** |

> no-login 이라 봇·남용이 곧 비용입니다. 레이트리밋·비용가드·BotID 가 비용 폭주를 1차 차단합니다.

---

## 9. 가용성 · 모니터링

| 항목 | 도구 |
|---|---|
| 함수 메트릭·에러 | Vercel Analytics + Logs (Sentry 도입 검토) |
| API 응답시간·토큰 | `query_log.total_ms`·`tokens_*` (관리자 대시보드) |
| 레이트리밋·비용가드 발동 | 서버 로그 + 비용 임계치 이메일 경고 |
| 봇 트래픽 | Vercel BotID/WAF 대시보드 |
| 인용 검증율 | `query_log.citation_verified` |

### 장애 대응

- **Upstash 다운**: 프로덕션 레이트리밋·비용가드 fail-closed(챗 429). 로그인은 fail-open(운영자 락아웃 방지).
- **법제처/임베딩/재정렬/Anthropic 다운**: 타임아웃·재시도·폴백 후 일반화 안내.
- **Supabase 다운**: 시스템 전체 장애.

---

## 10. 데이터 보존 · 삭제

| 데이터 | 보존 | 삭제 |
|---|---|---|
| `query_log` | 1년(집계 후 익명화 검토) | Cron |
| `crawl_runs` | 6개월 | Cron |
| `law_cache` | TTL 만료 시 | `ttl_at < now()` |
| Redis 카운터 | 일일 TTL(2일) 자동 만료 | 자동 |

---

## 11. 오픈 전 보안 하드닝 체크리스트

### Critical (오픈 전 반드시) — 현황

- [x] **`/api/ingest` 보호**: `INGEST_SECRET` 잠금 + 미들웨어 404 은닉.
- [x] **봇차단·레이트리밋·비용가드**: BotID + Upstash 레이트리밋(IP/분·IP/일·전역/일) + 일일 토큰 예산. (프로덕션 활성 — Upstash 프로비저닝 필요)
- [x] **에러 일반화**: `/api/chat`·`/api/health` 원문 비노출(서버 로그만).
- [x] **입력 제한**: 질문 길이·대화 턴 수 상한.
- [x] **관리자 보호**: 아이디+비번+서명 `__Host-` 쿠키 + 로그인 브루트포스 레이트리밋.

### High (오픈 전 권장) — 현황

- [x] **보안 헤더**: HSTS·X-Frame-Options·nosniff·Referrer-Policy·Permissions-Policy + **nonce 기반 CSP**(미들웨어).
- [x] **비용 경고**: 예산 임계치 도달 시 관리자 이메일(Resend).
- [ ] **타임아웃·재시도**: 모든 외부 호출에 일관 적용(부분 적용 — 점검 필요).
- [ ] **Vercel WAF 룰**: 대시보드에서 레이트 룰·Attack Mode 설정(코드 밖 작업).

### Medium (안정화)

- [ ] **관측성**: 요청 상관 ID + Sentry.
- [ ] **`/api/health` 확장**: 외부 API 연결 상태까지 점검.
- [ ] **최소 테스트·CI**: 핵심 경로(봇차단·레이트리밋·색인 잠금·관리자 게이트) 테스트.

---

## 12. 알려진 리스크 · 완화

| 리스크 | 가능성 | 영향 | 완화 |
|---|---|---|---|
| no-login 남용·봇 비용 폭주 | 중 | 고 | BotID + 레이트리밋 + 비용가드(토큰 예산·경고) + WAF |
| 색인 API 외부 노출 | 저 | 고 | `INGEST_SECRET` 잠금 + 404 은닉 |
| Upstash 장애로 챗 중단 | 저 | 중 | 프로덕션 fail-closed(비용 보호). 복구 시 자동 회복 |
| LLM 환각 인용 | 중 | 고 | `verify_citations` 강제, 환각 배지 |
| 관리자 비번 유출 | 저 | 고 | 서명키 분리(`ADMIN_SESSION_SECRET`), 브루트포스 레이트리밋, 비번 교체=세션 무효화 |
| 내부 오류 메시지 노출 | 저 | 중 | 에러 일반화 + 서버 로그 분리 |

---

## 13. 외부 의존성 · 라이센스

| 패키지 | 용도 | 라이센스 |
|---|---|---|
| Next.js | 웹/API 프레임워크 | MIT |
| @supabase/supabase-js | DB 클라이언트(service_role) | MIT |
| openai | 임베딩 | Apache-2.0 계열 |
| cohere-ai | 재정렬 | MIT |
| @anthropic-ai/sdk | 답변 LLM | MIT |
| @upstash/ratelimit · @upstash/redis | 레이트리밋·비용가드 저장소 | MIT |
| botid | Vercel 봇 차단 | MIT |
| resend | 경고 이메일 | MIT |
| cheerio | 크롤링 HTML 파싱 | MIT |
| zod | 입력·환경변수 검증 | MIT |

→ 신규 의존성 추가 시 라이센스 확인 필수.
