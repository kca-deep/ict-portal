# 데이터 모델 (Supabase Postgres)

> **한 줄 요약**: ICT 포털이 쓰는 데이터베이스 표(테이블) 명세서입니다. 내부 규정/법령 검색용 문서, 사용자 질문·답변 로그, 크롤링한 공모사업 정보 등을 어떤 칸(컬럼)에 담는지 비전문가도 알 수 있게 정리했습니다.

## 0. 용어 한 줄 정의

처음 보는 전문용어가 나오면 아래를 참고하세요.

| 용어 | 한 줄 뜻 |
|---|---|
| 임베딩(벡터, `vector`) | 글의 의미를 숫자 배열(여기선 1024개)로 바꾼 것. 의미가 비슷한 글끼리 가깝게 모여 '의미 검색'에 사용. 본 프로젝트는 **OpenAI `text-embedding-3-small`(1024차원)** 로 생성. |
| 전문검색(`tsvector`) | 글을 검색용 단어 단위로 쪼개 놓은 형태. '단어가 들어간 글 찾기'(키워드 검색)에 사용. |
| HNSW | 임베딩(벡터)을 빠르게 찾기 위한 색인(인덱스) 방식. '비슷한 의미' 검색을 빠르게 해 줌. |
| GIN | 전문검색(`tsvector`)·JSON 데이터용 색인(인덱스) 방식. 키워드 검색을 빠르게 해 줌. |
| RLS(행 수준 보안) | 표의 '행(레코드)'마다 누가 볼 수 있는지 정하는 보안 규칙. 예: "사용자는 자기 로그만 본다". |
| service_role | 백엔드(서버)만 쓰는 관리자 권한. 보안 규칙(RLS)을 우회해 모든 데이터에 접근 가능. |
| 재정렬(rerank) | 검색 결과를 더 정확한 순서로 다시 매기는 별도 단계. Cohere `rerank-v3.5` 사용. **데이터 모델(표 구조)과는 무관**하므로 여기선 다루지 않음. |

## 1. 테이블 개요

| 테이블 | 무엇을 담나 | 기능 |
|---|---|---|
| `documents` | 내부 규정·지침·해석사례를 잘게 나눈 글 조각 + 임베딩(OpenAI 1024차원) | ① 어드바이저 |
| `regulation` | 내부 규정 텍스트 + 임베딩(OpenAI 1024차원). `documents`와 **동일한 스키마** | ① 어드바이저 |
| `query_log` | 사용자 질문·답변과 처리 메트릭 로그. **관리자 통계·세부 조회의 원천** | ① + 로그분석 |
| `law_cache` | 법령(법제처 OpenAPI 직접 호출, 자체 구현 도구) 응답을 잠시 저장하는 캐시 | ① 어드바이저 |
| `announcements` | 수집한 공모사업 공고 정보 (API/스크래핑 공통 저장) | ② 파이프라인 |
| `crawler_sources` | 수집 대상 목록 + **수집 방식(API/HTML)·설정(`config`)** | ② 파이프라인 |
| `crawl_runs` | 수집 실행 이력 | ② 파이프라인 |
| `project_history` | 과거·진행 중 과제 이력 (수혜자별) | ③ 중복수혜 (선택 기능용) |
| `project_embeddings` | 과제 사업계획서 글 조각 + 임베딩 | ③ 중복수혜 (선택 기능용) |
| `duplicate_check_runs` | 중복수혜 조회 실행 결과 | ③ 중복수혜 (선택 기능용) |

> 검색에 쓰이는 표는 `documents`와 `regulation`이며, 둘 다 같은 구조에 OpenAI 임베딩(1024차원)을 사용합니다.

## 2. 핵심 컬럼 설계 원칙

모든 표에 공통으로 적용하는 규칙입니다.

- **`id`** — `bigint generated always as identity primary key` (자동 증가 번호. 별도 식별자 불필요)
- **타임스탬프** — `created_at timestamptz default now()`(생성 시각 자동 기록), `updated_at`(수정 시각, 트리거로 자동 갱신)
- **메타데이터** — `metadata jsonb default '{}'::jsonb` (부가 정보를 JSON으로 담는 칸. 일관되게 사용)
- **임베딩(벡터)** — `extensions.vector(1024)` — **OpenAI `text-embedding-3-small`(1024차원)**
- **전문검색** — `tsvector` 자동 생성 컬럼 + GIN 인덱스 (키워드 검색용)
- **RLS(행 수준 보안)** — 모든 표에 `enable row level security` 적용. 외부에 노출되는 표는 service_role 외에 명시적 접근 규칙을 둠

## 3. ① 어드바이저 테이블

### `documents`

**무엇을 담나**: 내부 규정·지침·FAQ·해석사례를 검색하기 좋게 잘게 나눈 글 조각과, 그 의미를 담은 임베딩.

```
컬럼              타입                          설명
─────────────────────────────────────────────────────
id                bigint (PK)
source            text     not null            'internal_regulation' | 'guideline' | 'faq' | 'interpretation_case'
doc_type          text                         '운영규정' | '시행세칙' 등
title             text
content           text     not null
chunk_index       int      default 0           원문을 나눈 조각 순번
source_ref        text                         내부 문서번호
metadata          jsonb    default '{}'        {"chapter":"제2장","article":"제5조","tags":[...]}
embedding         vector(1024)                 OpenAI text-embedding-3-small
fts               tsvector generated stored    to_tsvector('simple', title || ' ' || content)
created_at        timestamptz default now()
updated_at        timestamptz default now()

인덱스
─────────────────────────────────────────────────────
hnsw  on embedding (vector_ip_ops)            의미 검색 빠르게
gin   on fts                                  키워드 검색 빠르게
btree on source                               출처별 필터
gin   on metadata                             JSON 조건 검색

정책 (RLS)
─────────────────────────────────────────────────────
RLS enabled
SELECT to authenticated  using (true)         로그인 사용자는 모두 조회 가능
INSERT/UPDATE/DELETE: service_role 만 (RLS 우회)
```

### `regulation`

**무엇을 담나**: 내부 규정 텍스트와 임베딩. 구조(컬럼·인덱스·RLS)는 `documents`와 **완전히 동일**합니다. 임베딩은 동일하게 **OpenAI `text-embedding-3-small`(1024차원)** 을 사용합니다. 규정 전용으로 분리해 관리하기 위한 표입니다.

### `query_log`

**무엇을 담나**: 사용자가 한 질문, 시스템이 준 답변, 그리고 처리 과정의 측정값(속도·토큰 등)을 기록합니다. **이 표가 관리자 화면의 채팅 로그 통계와 세부 조회의 원천 데이터**입니다.

```
컬럼                타입         설명
─────────────────────────────────────────────────────
id                  bigint (PK)
session_id          text         대화 세션 식별자
user_id             uuid         auth.users 참조 (질문한 사용자)
query               text         사용자 질문
answer              text         시스템 답변
retrieved_doc_ids   bigint[]     답변에 사용한 문서 id 목록
cited_law_refs      jsonb        인용한 법령 목록 (법제처 OpenAPI / 자체 구현 법령 도구 기준)
                                 [{"law":"근로기준법","article":"제53조","date":"2024-05-17"}, ...]
citation_verified   boolean      인용 검증(verify_citations, 자체 구현 법령 도구) 통과 여부
llm_model           text         사용한 LLM 모델명
retrieval_ms        int          검색에 걸린 시간(ms)
rerank_ms           int          재정렬에 걸린 시간(ms)
llm_ms              int          LLM 답변 생성에 걸린 시간(ms)
total_ms            int          전체 처리 시간(ms)
tokens_in           int          입력 토큰 수
tokens_out          int          출력 토큰 수
feedback            smallint     사용자 평가 (-1 ~ 1)
feedback_note       text         사용자 피드백 메모
created_at          timestamptz  기록 시각

정책 (RLS)
─────────────────────────────────────────────────────
SELECT: 사용자는 자기 로그만 (auth.uid() = user_id)
INSERT: service_role (백엔드에서만 기록)
```

**관리자 로그 관점**: 관리자 화면의 채팅 로그 목록·통계·세부 조회는 모두 이 표를 바탕으로 만듭니다. 운영 편의를 위해 아래 항목을 **추가하면 좋습니다(추가 예정/권장 — 현재 스키마에는 없음)**.

| 추가 권장 항목 | 무엇을 위한 것 |
|---|---|
| 소속 기관 | 어느 기관 사용자의 질문인지 기관별로 통계·필터 |
| 분기 결과(내부 규정 / 법령) | 질문이 내부 규정으로 답해졌는지, 법령으로 답해졌는지 구분 집계 |
| 관련도 점수 | 검색·재정렬 결과가 얼마나 잘 맞았는지 품질 모니터링 |

### `law_cache`

**무엇을 담나**: 법령 조회(법제처 OpenAPI를 직접 호출하는 자체 구현 도구 `lib/law/`) 결과를 잠시 저장해, 같은 질문에 매번 외부를 다시 부르지 않도록 하는 캐시입니다.

```
컬럼          타입                  설명
─────────────────────────────────────────────────────
cache_key   text PK              'search_law:근로기준법:제53조'
tool_name   text not null        호출한 법령 도구명 (자체 구현, 예: search_law, get_law_text, verify_citations)
payload     jsonb not null       응답 결과 원본
ttl_at      timestamptz not null 이 시각 이후 만료(폐기)
created_at  timestamptz default now()

용도: 법제처 OpenAPI 응답(자체 구현 법령 도구) + 인용 검증(verify_citations) 결과 캐시 (기본 TTL 24시간)
```

## 4. ② 크롤러 테이블

### `crawler_sources`

**무엇을 담나**: 어떤 곳에서, 어떤 방식으로 공고를 수집할지 정의한 목록입니다. 소스마다 **API형(알리오/공식 API)** 인지 **HTML형(스크래핑)** 인지를 `source_type`으로 구분하고, 세부 설정은 `config`(JSON)에 담습니다. (기존 `list_selector`/`detail_selector` 컬럼은 `config.selectors`로 통합되었습니다.)

```
id              bigint PK
name            text         '과학기술정보통신부 공고' 등
agency          text         소관기관
source_type     text not null  'alio_api' | 'api' | 'html'   수집 방식 구분
base_url        text         HTML형: 수집 진입점 / API형: 호출 기준 URL
config          jsonb default '{}'   수집 설정 (아래 §4.1 규약)
crawl_interval  interval     default '6 hours'   재방문 주기
enabled         boolean      default true        사용 여부
last_crawled_at timestamptz                      마지막 수집 시각
metadata        jsonb        default '{}'

인덱스: btree(source_type, enabled)              활성 소스 분기 조회
```

#### 4.1 `config` 규약 (`source_type`별)

설정을 **코드가 아닌 DB(`config`)에** 두어, 소스 추가·수정을 **배포 없이 데이터 변경**으로 처리합니다. (설계 배경·추출 티어 전략: [`05-feature-crawler.md` §5](./05-feature-crawler.md))

```jsonc
// source_type = 'alio_api' | 'api'
{
  "endpoint": "/api/business",
  "filters": { "schSvcCate": "05", "schFstCateCd": ["B07", "B03", "B09"], "pageSize": 1000 }
}

// source_type = 'html'  (추출 티어 0~3)
{
  "fetcher": "jina",                 // 'fetch'(cheerio) | 'jina' | 'hosted'
  "template_family": "egovframe-board",
  "extract_tier": 3,                 // 0=셀렉터없음 1=공용 2=사이트별 3=LLM자가추론캐싱
  "selectors": {                     // 티어2~3에서 채움(티어3은 LLM이 자동 생성·캐시)
    "list": "...", "title": "...", "date": "...",
    "url": "...", "body": "...", "attachments": "..."
  },
  "infer": { "enabled": true, "last_inferred_at": "2026-08-xx", "min_yield": 0.8 },
  "attachment": { "types": ["pdf", "hwp"], "pdf_parser": "jina", "hwp_parser": "lib" }
}
```

### `announcements`

**무엇을 담나**: 크롤링으로 수집한 공모사업 공고 한 건 한 건을 담습니다.

```
id              bigint PK
source_id       bigint references crawler_sources(id)
external_id     text         원본 공고 ID(API 식별자 또는 해시). 중복 판별 키
title           text not null
agency          text
posted_at       date         게시일
deadline        date         마감일
url             text         원본 URL
raw_content     text         원문 HTML 또는 텍스트
content_hash    text         본문 해시. 값이 바뀐 경우에만 재분류·재임베딩(비용 절약)
attachments     jsonb        default '[]'   첨부 목록 [{"name":"...","url":"...","type":"pdf|hwp","text":"..."}]
extracted       jsonb        {"summary":"...", "target":"...", "fund_amount":"...", "reasoning":"..."}
category        text         '비R&D-스타트업지원' 등
is_ict_fund     boolean      ICT 공모인지 AI 판별 결과
confidence      numeric(3,2) 분류 신뢰도(0.00~1.00). 임계 미만은 검수 큐로
review_status   text default 'auto'   'auto' | 'pending' | 'approved' | 'rejected'
embedding       vector(1024) OpenAI text-embedding-3-small (검색용)
fts             tsvector generated                    키워드 검색용
created_at      timestamptz
updated_at      timestamptz

unique (source_id, external_id)              같은 공고 중복 저장 방지
인덱스: hnsw(embedding), gin(fts), btree(deadline) where deadline >= current_date,
        btree(review_status) where review_status = 'pending'   검수 큐 조회
```

### `crawl_runs`

**무엇을 담나**: 크롤링을 한 번 돌릴 때마다 결과(성공/실패, 건수)를 기록한 실행 이력입니다.

```
id              bigint PK
source_id       bigint references crawler_sources(id)
started_at      timestamptz default now()
finished_at     timestamptz
status          text         'running' | 'success' | 'partial' | 'failed'
items_found     int          발견 건수
items_inserted  int          신규 저장 건수
items_updated   int          갱신 건수
error_message   text
metadata        jsonb                     티어3 셀렉터 재추론 이벤트 등 부가 기록
```

> 한 소스가 실패해도 배치 전체를 멈추지 않고 해당 실행만 `partial`/`failed`로 기록합니다. 티어3 셀렉터 자가추론이 발생하면 `metadata`에 추론 사유·대상 필드를 남겨 추적합니다.

## 5. ③ 중복수혜 테이블 (선택 기능용)

> 아래 세 표는 중복수혜 점검이라는 **선택 기능**을 위한 것입니다. 기본 기능에는 쓰이지 않으며, 필요 시 활성화합니다.

### `project_history`

**무엇을 담나**: 수혜자별로 과거·진행 중인 과제 이력을 담습니다.

```
id              bigint PK
applicant_id    text         사업자등록번호 또는 익명화 ID
project_title   text
agency          text
program_name    text         공모사업명
period_start    date
period_end      date
budget_total    numeric(15,2)
budget_labor    numeric(15,2)
participation_rate  numeric(5,2)   참여율(%)
content_summary text
status          text         'completed' | 'in_progress' | 'planned'
source          text         원본 출처
metadata        jsonb
created_at      timestamptz

인덱스: btree(applicant_id, period_start desc)
```

### `project_embeddings`

**무엇을 담나**: 과제 사업계획서를 잘게 나눈 글 조각과 임베딩으로, 비슷한 과제를 찾는 데 씁니다.

```
id              bigint PK
project_id      bigint references project_history(id)
chunk_index     int
content         text         사업계획서 청크
embedding       vector(1024) OpenAI text-embedding-3-small
extracted_keywords text[]
created_at      timestamptz

인덱스: hnsw(embedding)
```

### `duplicate_check_runs`

**무엇을 담나**: 중복수혜 점검을 한 번 돌린 결과(유사 과제·위험도)를 기록합니다.

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

`documents`(및 동일 스키마인 `regulation`)에 대해 키워드 검색(BM25/tsvector)과 의미 검색(임베딩/pgvector)을 RRF 방식으로 합쳐 결과를 냅니다. 모든 검색 호출은 이 함수를 통과합니다. 같은 패턴을 `announcements`, `project_embeddings`용으로 확장할 예정입니다.

> 참고: 검색 후 더 정확한 순서로 다시 매기는 **재정렬(rerank)** 은 Cohere `rerank-v3.5`이 담당하는 별도 단계이며, 이 함수나 표 구조와는 무관합니다.

### `tg_set_updated_at()`

`updated_at`(수정 시각)을 자동으로 갱신하는 트리거 함수. 수정 가능한 모든 표에 적용합니다.

## 7. 인덱스 전략

| 테이블 | 인덱스 | 이유 |
|---|---|---|
| `documents` / `regulation` | HNSW + GIN + btree(source) | 하이브리드 검색 + 필터 |
| `crawler_sources` | btree(source_type, enabled) | 활성 소스 분기 조회 |
| `announcements` | HNSW + GIN + btree(deadline) + btree(review_status) | 마감 임박 정렬 + 검수 큐 |
| `query_log` | btree(created_at desc), btree(user_id, created_at desc) | 로그 분석 |
| `law_cache` | btree(ttl_at) | 만료 캐시 정리 |

## 8. RLS 정책 요약

| 테이블 | SELECT (누가 조회) | INSERT/UPDATE/DELETE (누가 쓰기) |
|---|---|---|
| `documents` / `regulation` | authenticated 전체 | service_role |
| `query_log` | 자기 로그만 | service_role |
| `law_cache` | (없음) | service_role |
| `crawler_sources` | service_role (관리자 API 경유) | service_role |
| `announcements` | authenticated 전체 | service_role |
| `crawl_runs` | service_role (관리자 API 경유) | service_role |
| `project_history` | service_role (민감) | service_role |
| `duplicate_check_runs` | 자기 실행만 | service_role |

민감 표(`project_history`, `project_embeddings`)는 조회(SELECT)도 service_role로 제한합니다 — 백엔드 API를 통해서만 접근합니다.

## 9. 마이그레이션 파일 명명

`supabase/migrations/YYYYMMDDHHMMSS_<name>.sql` 형식. Supabase CLI 표준입니다.

생성 순서 (1~5는 작성 완료, 6~9는 향후):

1. `20260520000001_init_extensions.sql`
2. `20260520000002_documents_table.sql`
3. `20260520000003_hybrid_search_fn.sql`
4. `20260520000004_query_log_table.sql`
5. `20260520000005_law_cache_table.sql`
6. `20260520000006_crawler_sources.sql` (예정 — `source_type`·`config` 포함)
7. `20260520000007_announcements.sql` (예정 — `content_hash`·`confidence`·`review_status`·`attachments` 포함)
8. `20260520000008_crawl_runs.sql` (예정)
9. `20260520000009_project_history.sql` (예정)
10. `20260520000010_duplicate_check_runs.sql` (예정)

> ②크롤러 3종(6~8)은 **기능 코드와 분리한 단독 PR**로 추가합니다(PoC 정책). 마이그레이션은 append-only이며 기존 파일을 수정하지 않습니다.
