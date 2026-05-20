# 보안 · 운영 · 비용

## 1. 데이터 흐름 다이어그램 (보안 검토용)

```
                        ┌──────────────────────────┐
                        │  사용자 (인증)           │
                        └──────────┬───────────────┘
                                   │ HTTPS + Supabase JWT
                                   ▼
            ┌────────────────────────────────────────────┐
            │      Vercel (Next.js API routes)           │
            │                                            │
            │  - 입력 검증 (zod)                         │
            │  - 민감정보 마스킹 (③ 중복수혜만)          │
            │  - 외부 API 호출 (servern only)            │
            │                                            │
            └────┬─────────────┬───────────┬──────────┬──┘
                 │             │           │          │
                 ▼             ▼           ▼          ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ Supabase │  │ Anthropic│  │  Cohere  │  │ 법제처    │
        │ Postgres │  │   API    │  │  Embed   │  │ OpenAPI  │
        │  (RLS)   │  │          │  │ + Rerank │  │ (공개)   │
        └──────────┘  └──────────┘  └──────────┘  └──────────┘
```

→ 모든 외부 API 호출은 **Vercel 함수 내부에서만** 발생. 클라이언트는 외부 API를 직접 호출하지 않음. `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `COHERE_API_KEY`, `LAW_GO_KR_API_KEY`는 모두 서버 환경변수.

## 2. 보안성 검토 대응 (보고서 명시 1개월 일정)

| 검토 항목 | 답변 |
|---|---|
| 외부 클라우드 사용 근거 | 처리 데이터가 공개 가능 자료. Vercel·Supabase는 ISO 27001·SOC 2 인증 |
| 외부 LLM API 사용 근거 | 답변 생성용. 입력은 공개 가능 자료. Anthropic API는 데이터 학습 미사용(Zero-data-retention 옵션 검토) |
| 키 관리 | Vercel 환경변수 + Supabase Vault. 클라이언트 노출 0 |
| 민감 데이터 처리 (③) | 사업자번호·예산 등은 마스킹 후 외부 전송. 원본은 Supabase RLS로 보호 |
| 감사 로그 | `query_log`, `crawl_runs`, `duplicate_check_runs` 모두 적재 |
| 백업·복구 | Supabase 자동 백업 (Pro: 7일 PITR) |
| 접근 통제 | Supabase Auth + RLS + 관리자/일반 사용자 권한 분리 |

## 3. 인증·인가

### 사용자 분류

| 역할 | 권한 |
|---|---|
| `anonymous` | 미인증 — 접근 불가 (관리자가 공개 페이지 별도 설정 시만 허용) |
| `authenticated` | 일반 사용자 — 어드바이저 사용, 자기 query_log 열람 |
| `admin` | 관리자 — 모든 페이지, 크롤링 결과 관리, 중복수혜 조회 |

→ Supabase Auth `app_metadata.role` 활용 (보안: `user_metadata` 미사용).

### RLS 정책 패턴

```sql
-- 사용자는 자기 로그만
create policy "query_log_self" on public.query_log
  for select to authenticated
  using (auth.uid() = user_id);

-- 관리자는 모든 로그
create policy "query_log_admin" on public.query_log
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
```

## 4. 민감정보 마스킹 (③ 모듈)

`lib/security/mask.ts` 신규 작성:

```ts
const PATTERNS = {
  business_id: /\d{3}-\d{2}-\d{5}/g,           // 사업자등록번호
  rrn:         /\d{6}-\d{7}/g,                  // 주민등록번호
  phone:       /01[016789]-?\d{3,4}-?\d{4}/g,   // 휴대전화
  email:       /[\w.-]+@[\w.-]+\.\w+/g,
};

export function maskAndTokenize(text: string): { masked: string; tokens: Map<string, string> };
export function restoreTokens(text: string, tokens: Map<string, string>): string;
```

→ 외부 LLM 전송 전 `maskAndTokenize`, 응답 후 `restoreTokens`.

## 5. 캐싱 전략

### 5.1 `law_cache` (법제처 응답)

| 도구 | TTL |
|---|---|
| `search_law`, `get_law_article` | 24시간 (법령은 자주 안 바뀜) |
| `search_precedent` | 24시간 |
| `verify_citation` | 7일 (인용 검증 결과) |
| `time_travel` | 30일 |

### 5.2 Prompt Caching (Anthropic)

- 시스템 프롬프트(`SYSTEM_PROMPT`)에 `cache_control: { type: "ephemeral" }`
- 5분 TTL → 활발한 사용 시 비용 90% 절감
- Tool 정의는 캐싱 prefix에 포함 (변경 빈도 낮음)

### 5.3 Edge Caching

- `/api/health` 등 정적 응답은 Vercel Edge Cache
- 인증 필요 라우트는 `no-store`

## 6. 비용 추정 (운영 시 월 기준)

가정: 어드바이저 일 100건 질의 (월 3,000건)

| 항목 | 단가 | 월 비용 |
|---|---|---|
| Vercel Pro | $20 | $20 |
| Supabase Pro | $25 | $25 |
| Anthropic Sonnet 4.6 | $3/M input, $15/M output | $30~60 |
| Cohere Embed v4 (초기 1회 100K 청크) | $0.12/M tokens | 초기 $20, 운영 $2 |
| Cohere Rerank v4 (3K queries × 30 docs) | $2/M tokens | $5~10 |
| 법제처 OpenAPI | 무료 | $0 |
| **합계 (운영 정상화 후)** | | **약 $80~120/월** |

PoC 단계는 사용량이 적어 무료 티어 + Pro 구독 비용 정도.

크롤러(②) 본격 가동 시 분류용 LLM 비용 추가 ($20~40/월 예상).

## 7. 가용성·모니터링

### 모니터링 항목

| 항목 | 도구 |
|---|---|
| Vercel 함수 메트릭 | Vercel Analytics + Logs |
| Supabase Postgres | Supabase Dashboard |
| API 응답시간 | `query_log.total_ms` |
| 크롤링 성공률 | `crawl_runs.status` 집계 |
| 인용 검증율 | `query_log.citation_verified` |
| 오류율 | Vercel error logs + Sentry (도입 검토) |

### 장애 대응

- **법제처 API 다운**: `law_cache`로 fallback, "법제처 일시 장애" 안내
- **Anthropic API 다운**: 사용자 안내 + 추후 자동 재시도
- **Supabase 다운**: 시스템 전체 장애 — Supabase 다중 리전 고려는 본 운영 단계

## 8. 데이터 보존·삭제

| 데이터 | 보존 기간 | 삭제 방법 |
|---|---|---|
| `query_log` | 1년 (집계 후 익명화) | Cron으로 user_id NULL 처리 |
| `crawl_runs` | 6개월 | Cron 삭제 |
| `law_cache` | TTL 만료 시 | `ttl_at < now()` 삭제 |
| `duplicate_check_runs` | 5년 (감사 추적) | 만료 시 익명화 |
| 사업계획서 원본 (Storage) | 분석 후 30일 | 자동 삭제 정책 |

## 9. 알려진 리스크·완화

| 리스크 | 가능성 | 영향 | 완화 |
|---|---|---|---|
| 외부 API 비용 폭증 | 중 | 중 | 일일 한도 + 모니터링 |
| Anthropic·Cohere 가격 인상 | 저 | 중 | 분기별 재평가, 모델 교체 가능성 |
| 법제처 OpenAPI 정책 변경 | 저 | 고 | 자체 색인 옵션 보존 |
| 크롤링 사이트 구조 변경 | 고 | 저 | 사이트별 모니터링 + 알림 |
| LLM 환각으로 잘못된 인용 | 중 | 고 | `verify_citation` 강제, 미통과 시 답변 수정 |
| RLS 정책 누락 | 저 | 고 | 마이그레이션 PR 리뷰 체크리스트 |

## 10. 외부 의존성·라이센스

| 외부 패키지 | 라이센스 |
|---|---|
| Next.js | MIT |
| @supabase/supabase-js | MIT |
| @anthropic-ai/sdk | MIT |
| cohere-ai | MIT |
| cheerio | MIT |
| zod | MIT |

→ 모두 MIT 라이센스로 정부망 사용 적합. 신규 의존성 추가 시 라이센스 확인 필수.
