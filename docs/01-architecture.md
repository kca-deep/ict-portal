# 시스템 아키텍처 및 기술 스택

> **한 줄 요약** — 외부 기관 담당자가 로그인 후 사용하는 RAG(검색 기반 답변) 챗봇입니다. 내부 규정을 먼저 검색하고, 관련도가 낮으면 법령을 조회해 Claude가 근거와 함께 답합니다.

> 용어 한 줄 정의
> - **RAG**: 질문과 관련된 문서를 먼저 찾아(검색) 그 내용을 근거로 LLM이 답을 만드는 방식.
> - **임베딩**: 문장을 숫자 벡터로 바꿔 의미가 비슷한 문서를 찾을 수 있게 하는 변환.
> - **재정렬(Rerank)**: 1차로 찾은 후보들을 질문과의 적합도 순으로 다시 줄 세우는 단계.
> - **법령 도구**: 법제처 국가법령정보 공동활용 OpenAPI를 직접 호출하는 자체 구현 도구(`lib/law/`). 법령 검색·조문 원문·인용 검증을 수행한다.

---

## 1. 한눈에 보는 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│              사용자 (ICT기금 외부 기관 담당자)              │
│                  ※ 로그인 필수 (공개 가입 차단)             │
└─────────────────────────────┬───────────────────────────────┘
                              │ HTTPS
┌─────────────────────────────▼───────────────────────────────┐
│      Vercel (Next.js 15 App Router · Pro + Fluid Compute)   │
│      ※ 함수 런타임은 Node 고정 (Edge 미사용)               │
│                                                             │
│  ┌────────────────────────────────────────────────────┐   │
│  │ app/                                               │   │
│  │  ├─ page.tsx        사용자 채팅 UI                │   │
│  │  ├─ (admin)/        관리자 대시보드 (통계·로그)   │   │
│  │  └─ api/                                           │   │
│  │     ├─ chat                ① 어드바이저 RAG       │   │
│  │     ├─ ingest              문서 색인              │   │
│  │     ├─ duplicate-check     ③ 중복수혜 조회       │   │
│  │     ├─ cron/                                      │   │
│  │     │  ├─ crawl-announcements  ② 크롤러         │   │
│  │     │  └─ refresh-law-cache    법령 캐시 갱신   │   │
│  │     └─ health             헬스체크                │   │
│  └────────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────────┐   │
│  │ lib/                                               │   │
│  │  ├─ ai/      OpenAI(임베딩)·Cohere(재정렬)·Claude  │   │
│  │  ├─ law/     법제처 OpenAPI 직접 호출 (자체 구현)   │   │
│  │  ├─ crawler/ 공모 크롤러                          │   │
│  │  ├─ ocr/     PDF·이미지 표준화 (③용)             │   │
│  │  └─ db/      Supabase 클라이언트                  │   │
│  └────────────────────────────────────────────────────┘   │
└──────┬──────────┬──────────┬──────────┬────────────────────┘
       │          │          │          │
       ▼          ▼          ▼          ▼
 ┌──────────┐┌──────────┐┌──────────┐┌─────────────────┐
 │ Supabase ││  OpenAI  ││  Cohere  ││  Anthropic API  │
 │ Postgres ││ (임베딩) ││ (재정렬) ││ Claude          │
 │ pgvector ││ text-emb ││ rerank   ││ sonnet-4-6      │
 │ + tsv    ││ -3-small ││ -v4.0    ││ (스트리밍)      │
 │ + Auth   ││ 1024차원 ││          ││                 │
 └──────────┘└──────────┘└──────────┘└─────────────────┘
                                     ┌──────────────────────┐
                                     │ 법제처 OpenAPI       │
                                     │ (국가법령정보 직접   │
                                     │  호출·자체 구현)     │
                                     │  법령/판례           │
                                     └──────────────────────┘
                                     ┌──────────────────────┐
                                     │ 유관기관 공고 사이트 │
                                     │ (HTTP / HTML 크롤링) │
                                     └──────────────────────┘
```

- **임베딩(색인+쿼리)**: OpenAI `text-embedding-3-small` (1024차원). 한 번 정한 모델을 영구 유지하며, 교체나 전체 재색인은 하지 않습니다.
- **재정렬**: Cohere `rerank-v3.5`. 검색이 끝난 뒤 별도로 도는 단계이며, 임베딩과는 무관합니다.
- **법령**: 법제처 국가법령정보 공동활용 OpenAPI를 직접 호출하는 자체 구현 도구(`lib/law/`)로 조회합니다.
- **답변 LLM**: Anthropic Claude `claude-sonnet-4-6`. 스트리밍과 프롬프트 캐싱을 사용합니다.

---

## 2. 기술 스택 결정

| 레이어 | 선택 | 대안 검토 | 결정 근거 |
|---|---|---|---|
| 프레임워크 | **Next.js 15 (App Router) + TypeScript** | Remix, SvelteKit | Vercel 1급 지원, RSC + Streaming, 풀스택 단일 언어 |
| 호스팅 | **Vercel Pro + Fluid Compute** | AWS Lambda, Railway, Fly.io | 단일 인프라로 함수·UI·Cron·Edge Config 통합 |
| 함수 런타임 | **Node.js 고정 (Edge 미사용)** | Edge Runtime | Anthropic SDK 등이 Node API에 의존하여 Edge에서 동작 불가 |
| 함수 타임아웃 | **maxDuration 300s (Pro Fluid)** | 60s (기본) | RAG 1회 호출 8~18초 + 크롤링 여유 |
| DB · 벡터 | **Supabase Postgres + pgvector + tsvector** | Pinecone, Weaviate | RLS·Auth·Storage 통합, hybrid_search SQL 함수 native |
| 벡터 인덱스 | **HNSW (vector_ip_ops)** | IVFFlat | 2026년 pgvector 권장, 사전 색인 가능 |
| 임베딩 | **OpenAI `text-embedding-3-small` (1024차원)** | Cohere embed, OpenAI 3-large | 색인·쿼리 동일 모델로 영구 유지, 1024차원으로 pgvector 효율, 안정적 운영 |
| 리랭킹(재정렬) | **Cohere `rerank-v3.5` multilingual** | Voyage Rerank 2.5, Jina v2 | 한국어 포함 다국어 지원, 검색 후 적합도 재정렬에 특화 |
| 답변 LLM | **Claude `claude-sonnet-4-6` 단독** | GPT-5.5, Opus 듀얼 | 긴 컨텍스트, 스트리밍·프롬프트 캐싱 지원, Opus 대비 저렴. 평가 후 필요시 Opus 라우팅 추가 |
| 법령 도구 | **법제처 OpenAPI 직접 호출 (자체 구현 도구 `lib/law/`)** | korean-law MCP 런타임 연결 | korean-law MCP는 개발 환경 도구라 Vercel 서버리스에 상주 불가 → 동일 기능을 `lib/law`에 자체 함수로 구현. 법제처 공식 데이터, 실시간 조회, 인용 검증(verify_citations), `law_cache` 캐싱 |
| 크롤링 | **fetch + cheerio** | Playwright | 정적 HTML 위주. JS 렌더링 필요 사이트만 외부 스크래핑 API 도입 검토 |
| 한국어 형태소 | **PostgreSQL `simple` config** | pg_bigm, mecab-ko | 1차 PoC는 simple. 평가 결과 부족하면 pg_bigm 추가 |
| 인증 | **Supabase Auth (로그인 필수)** | NextAuth, Clerk | RLS와 일관, 공개 가입 차단·초대/승인 운영 가능, 추가 인프라 불필요 |
| 스타일 | **Tailwind CSS** | shadcn/ui 별도 도입은 미정 | 기본 채팅 UI에 충분, 본격 대시보드 단계에 결정 |

---

## 3. 외부 서비스 의존성

| 서비스 | 용도 | 비용 모델 | 키 관리 |
|---|---|---|---|
| **Vercel** | 호스팅, 함수, Cron | Pro 구독 + 사용량 | 콘솔에서 발급된 deployment token |
| **Supabase** | Postgres, Auth, Storage | Pro 구독 + 사용량 | `SUPABASE_SERVICE_ROLE_KEY` (서버 전용) |
| **OpenAI** | **임베딩** (색인+쿼리, `text-embedding-3-small`) | 토큰 종량 | `OPENAI_API_KEY` |
| **Cohere** | **재정렬** (`rerank-v3.5`) | 토큰 종량 | `COHERE_API_KEY` |
| **Anthropic** | 답변 LLM (`claude-sonnet-4-6`) | 토큰 종량 | `ANTHROPIC_API_KEY` |
| **법제처** | 국가법령정보 공동활용 OpenAPI 직접 호출(자체 구현 도구 `lib/law/`) — 법령·판례 조회 | 무료 (호출 한도 있음) | `LAW_GO_KR_API_KEY` |

### 서버 환경변수 키 목록

| 키 | 용도 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 프로젝트 URL (클라이언트 노출) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon 키 (클라이언트 노출) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 서버 전용 권한 키 |
| `OPENAI_API_KEY` | OpenAI 임베딩 호출 |
| `COHERE_API_KEY` | Cohere 재정렬 호출 |
| `ANTHROPIC_API_KEY` | Claude 답변 생성 |
| `LAW_GO_KR_API_KEY` | 법제처 OpenAPI(OC 인증값) — 자체 구현 법령 도구 `lib/law/` 조회 |

---

## 4. 검색·답변 파이프라인 (RAG 흐름)

검색은 `documents`(내부 규정 본문)·`regulation`(규정 메타) 테이블과,
`hybrid_search` / `regulation_search` RPC를 사용합니다.
이 RPC는 **BM25(키워드 검색) + pgvector(의미 검색)** 결과를 **RRF**(Reciprocal Rank Fusion, 두 순위를 하나로 합치는 방법)로 합칩니다.

```
┌──────────────────────────────────────────────────────────────┐
│ 0. 인증 확인 (Supabase Auth) — 비로그인 차단,               │
│    기관·사용자별 레이트리밋 적용                            │
│ 1. 사용자 질의 → /api/chat                                  │
│ 2. 질의를 OpenAI text-embedding-3-small(1024차원)로 임베딩  │
│ 3. Hybrid Search (BM25 + pgvector + RRF)                     │
│    → 내부 규정 후보 검색                                    │
│ 4. Cohere rerank-v3.5 재정렬 → 상위 결과 선별              │
│ 5. 관련도 분기:                                             │
│    · 상위 결과 관련도 점수 ≥ 기준치                         │
│        → 내부 규정만 근거로 사용                            │
│    · 기준치 미만                                            │
│        → 법제처 OpenAPI로 법령 조회 → 인용 검증           │
│          (verify_citations)                                  │
│ 6. Claude claude-sonnet-4-6가 근거를 바탕으로               │
│    최종 답변 생성 (스트리밍 + 프롬프트 캐싱)               │
│ 7. query_log 적재 (관리자 통계·세부 조회용)               │
└──────────────────────────────────────────────────────────────┘
```

- **임베딩과 재정렬은 다른 단계**입니다. 임베딩(OpenAI)은 검색용 벡터를 만들고, 재정렬(Cohere)은 찾은 후보를 다시 줄 세웁니다.
- 법령은 항상 부르지 않습니다. 내부 규정만으로 충분(관련도 ≥ 기준치)하면 법령 조회를 건너뜁니다.
- 모든 질의는 `query_log`에 적재되어 관리자 화면에서 통계와 세부 내역을 볼 수 있습니다.

자세한 내용은 [04-feature-advisor.md](./04-feature-advisor.md) 참고.

---

## 5. 접근 제어·운영 정책

| 항목 | 정책 |
|---|---|
| 이용 대상 | ICT기금 외부 기관 담당자 |
| 인증 | Supabase Auth로 **로그인 필수**. 공개 가입 차단, 초대·승인 방식으로만 계정 생성 |
| 레이트리밋 | 기관·사용자별로 호출 횟수 제한 |
| 관리자 로그 | 모든 채팅을 `query_log`에 적재, 관리자 통계·세부 조회 화면 제공 |

---

## 6. 운영 모드

| 환경 | URL/도메인 | 데이터 |
|---|---|---|
| 로컬 개발 | localhost:3000 | Supabase dev project |
| 스테이징 | (Vercel preview) | Supabase staging project |
| 운영 | (TBD) | Supabase prod project |

배포는 git push 기반 자동 (Vercel + Supabase branching 검토).
