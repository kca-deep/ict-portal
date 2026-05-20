# 시스템 아키텍처 및 기술 스택

## 1. 한눈에 보는 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                  사용자 (브라우저 / 내부망)                 │
└─────────────────────────────┬───────────────────────────────┘
                              │ HTTPS
┌─────────────────────────────▼───────────────────────────────┐
│      Vercel (Next.js 15 App Router · Pro + Fluid Compute)   │
│                                                             │
│  ┌────────────────────────────────────────────────────┐   │
│  │ app/                                               │   │
│  │  ├─ page.tsx        사용자 채팅 UI                │   │
│  │  ├─ (admin)/        관리자 대시보드               │   │
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
│  │  ├─ ai/      Cohere·Claude 통합                    │   │
│  │  ├─ law/     법제처 OpenAPI + Claude Tool Use     │   │
│  │  ├─ crawler/ 공모 크롤러                          │   │
│  │  ├─ ocr/     PDF·이미지 표준화 (③용)             │   │
│  │  └─ db/      Supabase 클라이언트                  │   │
│  └────────────────────────────────────────────────────┘   │
└────────┬───────────┬────────────────┬─────────────────────┘
         │           │                │
         ▼           ▼                ▼
   ┌──────────┐ ┌──────────┐  ┌─────────────────┐
   │ Supabase │ │  Cohere  │  │  Anthropic API  │
   │ Postgres │ │  Embed + │  │  Claude Sonnet  │
   │ pgvector │ │  Rerank  │  │      4.6        │
   │ + tsv    │ │          │  └─────────────────┘
   └──────────┘ └──────────┘
                            ┌──────────────────────┐
                            │ 법제처 OpenAPI       │
                            │ (open.law.go.kr)     │
                            └──────────────────────┘
                            ┌──────────────────────┐
                            │ 유관기관 공고 사이트 │
                            │ (HTTP / HTML 크롤링) │
                            └──────────────────────┘
```

## 2. 기술 스택 결정

| 레이어 | 선택 | 대안 검토 | 결정 근거 |
|---|---|---|---|
| 프레임워크 | **Next.js 15 (App Router) + TypeScript** | Remix, SvelteKit | Vercel 1급 지원, RSC + Streaming, 풀스택 단일 언어 |
| 호스팅 | **Vercel Pro + Fluid Compute** | AWS Lambda, Railway, Fly.io | 단일 인프라로 함수·UI·Cron·Edge Config 통합 |
| 함수 런타임 | **Node.js (Edge 미사용)** | Edge Runtime | MCP/Anthropic/Cohere SDK가 Node API 의존 |
| 함수 타임아웃 | **maxDuration 300s (Pro Fluid)** | 60s (기본) | RAG 1회 호출 8~18초 + 크롤링 여유 |
| DB · 벡터 | **Supabase Postgres + pgvector + tsvector** | Pinecone, Weaviate | RLS·Auth·Storage 통합, hybrid_search SQL 함수 native |
| 벡터 인덱스 | **HNSW (vector_ip_ops)** | IVFFlat | 2026년 pgvector 권장, 사전 색인 가능 |
| 임베딩 | **Cohere `embed-v4.0` (1024d, multilingual)** | OpenAI text-embedding-3-large | 한국어 SOTA, 128K context, 1024d로 pgvector 효율 |
| 리랭킹 | **Cohere `rerank-v4.0` multilingual** | Voyage Rerank 2.5, Jina v2 | 한국어 10대 비즈니스 언어 명시 지원, $2/1M tokens |
| 답변 LLM | **Claude Sonnet 4.6 단독** | GPT-5.5, Opus 4.7 듀얼 | 1M context, adaptive thinking, Opus 대비 1.67× 저렴. 평가 후 필요시 Opus 라우팅 추가 |
| 법령 도구 | **Anthropic Tool Use 자체 구현** | Korean Law MCP fork | Anthropic 단독이므로 MCP 표준 가치 ↓. 외부 fork 의존성 제거, Supabase 직접 통합 |
| 크롤링 | **fetch + cheerio** | Playwright | 법제처 OpenAPI·정적 HTML 위주. JS 렌더링 필요 사이트만 외부 스크래핑 API 도입 검토 |
| 한국어 형태소 | **PostgreSQL `simple` config** | pg_bigm, mecab-ko | 1차 PoC는 simple. 평가 결과 부족하면 pg_bigm 추가 |
| 인증 | **Supabase Auth** | NextAuth, Clerk | RLS와 일관, 추가 인프라 불필요 |
| 스타일 | **Tailwind CSS** | shadcn/ui 별도 도입은 미정 | 기본 채팅 UI에 충분, 본격 대시보드 단계에 결정 |

## 3. 외부 서비스 의존성

| 서비스 | 용도 | 비용 모델 | 키 관리 |
|---|---|---|---|
| **Vercel** | 호스팅, 함수, Cron | Pro 구독 + 사용량 | 콘솔에서 발급된 deployment token |
| **Supabase** | Postgres, Auth, Storage | Pro 구독 + 사용량 | `SUPABASE_SERVICE_ROLE_KEY` (서버 전용) |
| **Anthropic** | Claude Sonnet 4.6 | 토큰 종량 | `ANTHROPIC_API_KEY` |
| **Cohere** | 임베딩 + 리랭킹 | 토큰 종량 | `COHERE_API_KEY` |
| **법제처** | 법령·판례 OpenAPI | 무료 (호출 한도 있음) | `LAW_GO_KR_API_KEY` |

## 4. LLM Tool Use 패턴 (요점)

```
┌──────────────────────────────────────────────────────────┐
│ 1. 사용자 질의 → /api/chat                              │
│ 2. Hybrid Search (Supabase) → 내부 규정 후보 30건       │
│ 3. Cohere Rerank → 상위 8건                              │
│ 4. Claude messages.create(tools=[law tools 17개])        │
│ 5. Claude가 필요하면 search_law / verify_citation 등     │
│    도구 호출 → 백엔드가 법제처 API 호출 → 결과 반환     │
│ 6. Claude가 최종 답변 생성 (스트리밍)                    │
│ 7. query_log + cited_law_refs 적재                       │
└──────────────────────────────────────────────────────────┘
```

자세한 내용은 [04-feature-advisor.md](./04-feature-advisor.md) 참고.

## 5. 운영 모드

| 환경 | URL/도메인 | 데이터 |
|---|---|---|
| 로컬 개발 | localhost:3000 | Supabase dev project |
| 스테이징 | (Vercel preview) | Supabase staging project |
| 운영 | (TBD) | Supabase prod project |

배포는 git push 기반 자동 (Vercel + Supabase branching 검토).
