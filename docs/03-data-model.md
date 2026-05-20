# 데이터 모델 (Supabase Postgres)

## 1. 테이블 개요

| 테이블 | 용도 | 기능 |
|---|---|---|
| `documents` | 내부 규정·지침·해석사례 청크 + 임베딩 | ① 어드바이저 |
| `query_log` | 사용자 질의·답변·메트릭 로그 | ① + 로그분석 |
| `law_cache` | 법제처 OpenAPI 응답 캐시 | ① 어드바이저 |
| `announcements` | 크롤링한 공모사업 정보 | ② 파이프라인 |
| `crawler_sources` | 크롤링 대상 사이트 목록 + 셀렉터 | ② 파이프라인 |
| `crawl_runs` | 크롤링 실행 이력 | ② 파이프라인 |
| `project_history` | 과거·진행 중 과제 이력 (수혜자별) | ③ 중복수혜 |
| `project_embeddings` | 과제 사업계획서 청크 + 임베딩 | ③ 중복수혜 |
| `duplicate_check_runs` | 중복수혜 조회 실행 결과 | ③ 중복수혜 |

## 2. 핵심 컬럼 설계 원칙

- **`id`** — `bigint generated always as identity primary key` (snowflake 등 불필요)
- **타임스탬프** — `created_at timestamptz default now()`, `updated_at` 트리거로 자동 갱신
- **메타데이터** — `metadata jsonb default '{}'::jsonb` 패턴 일관 사용
- **벡터** — `extensions.vector(1024)` (Cohere embed-v4.0)
- **전문검색** — `tsvector` generated column + GIN 인덱스
- **RLS** — 모든 테이블 `enable row level security`, public 스키마 노출 시 service_role 외 명시 정책

## 3. ① 어드바이저 테이블

### `documents`

```
컬럼              타입                          설명
─────────────────────────────────────────────────────
id                bigint (PK)
source            text     not null            'internal_regulation' | 'guideline' | 'faq' | 'interpretation_case'
doc_type          text                         '운영규정' | '시행세칙' 등
title             text
content           text     not null
chunk_index       int      default 0
source_ref        text                         내부 문서번호
metadata          jsonb    default '{}'        {"chapter":"제2장","article":"제5조","tags":[...]}
embedding         vector(1024)                 Cohere embed-v4.0
fts               tsvector generated stored    to_tsvector('simple', title || ' ' || content)
created_at        timestamptz default now()
updated_at        timestamptz default now()

인덱스
─────────────────────────────────────────────────────
hnsw  on embedding (vector_ip_ops)
gin   on fts
btree on source
gin   on metadata

정책
─────────────────────────────────────────────────────
RLS enabled
SELECT to authenticated  using (true)
INSERT/UPDATE/DELETE: service_role 만 (RLS 우회)
```

### `query_log`

```
session_id, user_id, query, answer
retrieved_doc_ids   bigint[]
cited_law_refs      jsonb    [{"law":"근로기준법","article":"제53조","date":"2024-05-17"}, ...]
citation_verified   boolean  verify_citation 도구 통과 여부
llm_model           text
retrieval_ms / rerank_ms / llm_ms / total_ms / tokens_in / tokens_out
feedback            smallint  -1 ~ 1
feedback_note       text

정책: 사용자는 자기 로그만 SELECT (auth.uid() = user_id)
```

### `law_cache`

```
cache_key   text PK            'search_law:근로기준법:제53조'
tool_name   text not null      MCP 호환 도구명 (자체 구현에서도 동일하게 사용)
payload     jsonb not null
ttl_at      timestamptz not null
created_at  timestamptz default now()

용도: 법제처 API 응답 + verify_citation 결과 캐시 (TTL 24시간 기본)
```

## 4. ② 크롤러 테이블

### `crawler_sources`

```
id              bigint PK
name            text         '과학기술정보통신부 공고' 등
agency          text         소관기관
base_url        text         크롤링 진입점
list_selector   text         공고 목록 CSS 셀렉터
detail_selector jsonb        {"title":".board-title", "date":".board-date", ...}
crawl_interval  interval     default '6 hours'
enabled         boolean      default true
last_crawled_at timestamptz
metadata        jsonb        default '{}'
```

### `announcements`

```
id              bigint PK
source_id       bigint references crawler_sources(id)
external_id     text         원본 사이트 공고 ID
title           text not null
agency          text
posted_at       date
deadline        date
url             text         원본 URL
raw_content     text         원문 HTML 또는 텍스트
extracted       jsonb        {"summary":"...", "target":"...", "fund_amount":"...", ...}
category        text         '비R&D-스타트업지원' 등
is_ict_fund     boolean      AI 판별 결과
embedding       vector(1024) 검색용
fts             tsvector generated
created_at      timestamptz
updated_at      timestamptz

unique (source_id, external_id)
인덱스: hnsw(embedding), gin(fts), btree(deadline) where deadline >= current_date
```

### `crawl_runs`

```
id              bigint PK
source_id       bigint references crawler_sources(id)
started_at      timestamptz default now()
finished_at     timestamptz
status          text         'running' | 'success' | 'partial' | 'failed'
items_found     int
items_inserted  int
items_updated   int
error_message   text
metadata        jsonb
```

## 5. ③ 중복수혜 테이블

### `project_history`

```
id              bigint PK
applicant_id    text         사업자등록번호 또는 익명화 ID
project_title   text
agency          text
program_name    text         공모사업명
period_start    date
period_end     date
budget_total    numeric(15,2)
budget_labor    numeric(15,2)
participation_rate  numeric(5,2)
content_summary text
status          text         'completed' | 'in_progress' | 'planned'
source          text         원본 출처
metadata        jsonb
created_at      timestamptz

인덱스: btree(applicant_id, period_start desc)
```

### `project_embeddings`

```
id              bigint PK
project_id      bigint references project_history(id)
chunk_index     int
content         text         사업계획서 청크
embedding       vector(1024)
extracted_keywords text[]
created_at      timestamptz

인덱스: hnsw(embedding)
```

### `duplicate_check_runs`

```
id                  bigint PK
applicant_id        text
new_project_title   text
new_project_content text
matched_projects    jsonb     [{"project_id":123, "similarity":0.87, "reason":"..."}, ...]
overall_risk        text      'low' | 'medium' | 'high'
labor_overlap       numeric(5,2)  참여율 합산 (인건비 이중수급 판단)
performed_at        timestamptz default now()
performed_by        uuid references auth.users(id)
```

## 6. SQL 함수

### `hybrid_search(query_text, query_embedding, match_count, full_text_weight, semantic_weight, rrf_k)`

`documents` 테이블에 대한 BM25(tsvector) + 벡터(pgvector) + RRF 결합.
모든 검색 관련 호출은 이 함수를 통과. 동일 패턴을 `announcements`, `project_embeddings`용으로 확장 예정.

### `tg_set_updated_at()`

`updated_at` 자동 갱신 트리거 함수. 모든 mutable 테이블에 적용.

## 7. 인덱스 전략

| 테이블 | 인덱스 | 이유 |
|---|---|---|
| `documents` | HNSW + GIN + btree(source) | 하이브리드 검색 + 필터 |
| `announcements` | HNSW + GIN + btree(deadline) | 마감 임박 정렬 |
| `query_log` | btree(created_at desc), btree(user_id, created_at desc) | 로그 분석 |
| `law_cache` | btree(ttl_at) | 만료 캐시 정리 |

## 8. RLS 정책 요약

| 테이블 | SELECT | INSERT/UPDATE/DELETE |
|---|---|---|
| `documents` | authenticated 전체 | service_role |
| `query_log` | 자기 로그만 | service_role |
| `law_cache` | (없음) | service_role |
| `announcements` | authenticated 전체 | service_role |
| `project_history` | service_role (민감) | service_role |
| `duplicate_check_runs` | 자기 실행만 | service_role |

민감 테이블(`project_history`, `project_embeddings`)은 SELECT도 service_role 제한 — 백엔드 API를 통해서만 접근.

## 9. 마이그레이션 파일 명명

`supabase/migrations/YYYYMMDDHHMMSS_<name>.sql` 형식. Supabase CLI 표준.

생성 순서 (1~5는 작성 완료, 6~9는 향후):

1. `20260520000001_init_extensions.sql`
2. `20260520000002_documents_table.sql`
3. `20260520000003_hybrid_search_fn.sql`
4. `20260520000004_query_log_table.sql`
5. `20260520000005_law_cache_table.sql`
6. `20260520000006_crawler_sources.sql` (예정)
7. `20260520000007_announcements.sql` (예정)
8. `20260520000008_project_history.sql` (예정)
9. `20260520000009_duplicate_check_runs.sql` (예정)
