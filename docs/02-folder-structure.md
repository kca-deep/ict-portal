# 디렉토리 구조 (root 기준)

## 1. 원칙

- **루트 = Next.js 프로젝트 루트** (`D:\workspace\ict-portal\`). 하위에 별도 앱 폴더(`pims-app/` 같은)를 두지 않는다.
- 외부 의존성(Korean Law MCP 등)도 별도 폴더로 분리하지 않는다 — 모든 로직을 `lib/` 안에 직접 구현.
- 기존 워크스페이스 자료(hwpx 원본, 파싱 스크립트)는 그대로 루트에 공존 (gitignore로 분리 관리 가능).

## 2. 최종 구조

```
D:\workspace\ict-portal\                              ← Next.js 프로젝트 루트
│
├── app/                                              # Next.js App Router
│   ├── layout.tsx
│   ├── page.tsx                                      # 사용자 채팅 UI
│   ├── globals.css
│   ├── (admin)/                                      # 관리자 페이지 (라우트 그룹)
│   │   ├── announcements/page.tsx                    # 공모 목록·관리
│   │   ├── duplicate-check/page.tsx                  # 중복수혜 조회
│   │   └── logs/page.tsx                             # query_log 대시보드
│   └── api/
│       ├── chat/route.ts                             # ① 어드바이저 RAG
│       ├── ingest/route.ts                           # 문서 임베딩·색인
│       ├── duplicate-check/route.ts                  # ③ 중복수혜 조회
│       ├── cron/
│       │   ├── crawl-announcements/route.ts          # ② 공모 크롤러 (Vercel Cron)
│       │   └── refresh-law-cache/route.ts            # 법령 캐시 갱신
│       └── health/route.ts                           # 헬스체크
│
├── lib/                                              # 도메인 로직
│   ├── env.ts                                        # zod 환경변수 검증
│   ├── db/
│   │   ├── supabase.ts                               # admin / anon 클라이언트
│   │   └── search.ts                                 # hybrid_search RPC 래퍼
│   ├── ai/
│   │   ├── embedding.ts                              # Cohere embed-v4
│   │   ├── rerank.ts                                 # Cohere rerank-v4
│   │   ├── llm-router.ts                             # Claude Sonnet 4.6 + tool runner
│   │   └── prompts.ts                                # 시스템 프롬프트
│   ├── law/                                          # 법령 도구 (자체 구현, MCP 미사용)
│   │   ├── go-kr-client.ts                           # 법제처 OpenAPI 클라이언트
│   │   ├── tools.ts                                  # Anthropic.Tool schema 17개
│   │   ├── handlers.ts                               # 도구 실행 로직
│   │   ├── citation-verify.ts                        # 인용 검증 알고리즘
│   │   ├── impact-map.ts                             # 조문 영향 그래프
│   │   └── cache.ts                                  # law_cache 테이블 활용
│   ├── crawler/                                      # ② 공모사업 크롤러
│   │   ├── sources.ts                                # 전담기관 사이트 목록·셀렉터
│   │   ├── fetch.ts                                  # 정적 HTML fetch + cheerio
│   │   ├── classify.ts                               # AI 비R&D 판별
│   │   └── normalize.ts                              # 카테고리화·요약·구조화
│   └── ocr/                                          # ③ 비정형 문서 표준화 (10~11월)
│       └── (PDF·이미지 OCR 어댑터)
│
├── supabase/
│   ├── config.toml                                   # Supabase CLI 설정
│   └── migrations/
│       ├── 20260520000001_init_extensions.sql        # pgvector + pg_trgm
│       ├── 20260520000002_documents_table.sql        # ① RAG 문서
│       ├── 20260520000003_hybrid_search_fn.sql       # ① RRF 함수
│       ├── 20260520000004_query_log_table.sql        # ① 사용 로그
│       ├── 20260520000005_law_cache_table.sql        # 법령 응답 캐시
│       ├── 20260520000006_announcements.sql          # ② 크롤링 결과
│       └── 20260520000007_project_history.sql        # ③ 과거 과제 이력
│
├── docs/                                             # 기획 문서 (본 폴더)
│   ├── 00-overview.md
│   ├── 01-architecture.md
│   ├── 02-folder-structure.md
│   ├── 03-data-model.md
│   ├── 04-feature-advisor.md
│   ├── 05-feature-crawler.md
│   ├── 06-feature-duplicate.md
│   └── 07-security-ops.md
│
├── 붙임3. 사업계획서(ICT기금 사용자 서비스 구축).hwpx  # 원본 기획서
├── parse_hwpx.py                                     # hwpx 파싱 헬퍼
│
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── next.config.ts
├── tailwind.config.ts
├── postcss.config.mjs
├── vercel.json                                       # 함수 maxDuration·메모리·Cron
├── .env.example
├── .env.local                                        # (gitignore)
├── .gitignore
└── README.md
```

## 3. 디자인 결정 요약

| 항목 | 결정 | 근거 |
|---|---|---|
| **`pims-app/` 하위 폴더** | ❌ 사용하지 않음 | 사용자 요청 — root를 곧 Next.js 프로젝트 루트로 사용 |
| **`korean-law-mcp/` 별도 폴더** | ❌ 사용하지 않음 | LLM 단독(Anthropic)이므로 MCP 표준 가치 ↓. 도구를 `lib/law/`에 자체 구현 |
| **`lib/`에 도메인별 하위 폴더** | ✅ `ai/`·`law/`·`crawler/`·`ocr/`·`db/` | 도메인 경계 명확, import 깔끔 |
| **App Router 라우트 그룹 `(admin)/`** | ✅ | URL 노출 없이 관리자 페이지 묶음 |
| **`docs/` 폴더** | ✅ | 기획·결정 사항 추적, AI 협업에도 유용 |

## 4. 기존 `pims-app/` 처리

이전 작업에서 `pims-app/` 하위에 생성한 코드는 다음 중 하나로 처리:

1. **루트로 이동** — 추후 사용자가 명시적으로 지시 시 진행
2. **참고용 유지** — 임시로 두고 새 코드는 루트에 작성
3. **삭제** — 새 출발

기획 단계에서는 우선 코드 이동·삭제를 보류하고, 구현 착수 시점에 사용자 확인 후 결정한다.

## 5. 환경변수 (.env)

`.env.example`에 다음 키를 정의하고 `.env.local`에 값을 채운다 (`.env.local`은 gitignore):

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# LLM
ANTHROPIC_API_KEY=
LLM_MODEL=claude-sonnet-4-6

# Cohere
COHERE_API_KEY=
EMBEDDING_MODEL=embed-v4.0
EMBEDDING_DIMENSIONS=1024
RERANK_MODEL=rerank-v4.0

# 법제처
LAW_GO_KR_API_KEY=
LAW_GO_KR_BASE_URL=https://www.law.go.kr/DRF/lawSearch.do

# RAG
RETRIEVAL_TOP_K=30
RERANK_TOP_K=8

# 크롤러
CRAWLER_USER_AGENT=PIMS-Crawler/1.0
CRAWLER_TIMEOUT_MS=10000
```
