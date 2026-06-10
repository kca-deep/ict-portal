# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

**PIMS (ICT기금 사용자 중심 AX서비스)** — 단일 Next.js 앱에 3대 기능을 통합한 2인 PoC 프로젝트.

1. **규정·법령 어드바이저** (`①`) — 내부 규정 + 법령 RAG. Hybrid Search + Citation 검증.
2. **공모지원사업 파이프라인** (`②`) — 유관기관 공고 크롤링 + AI 분류 + 통합 제공. (공모/지원사업 aggregator — **채용 공고 아님**.)
3. **중복수혜 조회** (`③`) — 신청 과제 vs 기존 과제 임베딩 유사도 분석 (PoC).

기획·아키텍처 의사결정의 진실원은 `docs/`. 본 파일은 코드 작업용 요약이며, 의사결정 근거가 필요하면 해당 문서를 우선 참조.

**현황·로드맵**: 챗봇 핵심(검색·재정렬·스트리밍 UI)은 개발완료 상태. 이용 대상은 **ICT기금 외부 기관 담당자**(로그인 필수, 공개 가입 차단, 초대·승인 기반 계정). AI 챗봇 개발완료 6월 말 → Vercel 오픈 환경설정·취약점 하드닝 → 정식 오픈 7월 말. 크롤러 8월 말, 중복수혜 8월 이후 선택.

## 기술 스택

- Next.js 15 App Router · TypeScript · Tailwind CSS · React 19
- pnpm 9.12 (packageManager 고정) · Node.js 20+
- Supabase Postgres + pgvector(1024d, HNSW) + tsvector + RLS
- Anthropic Claude Sonnet 4.6 (답변 LLM, 단독, 1M context)
- **임베딩: OpenAI `text-embedding-3-small` (1024d, 색인=쿼리 동일, 영구 고정 — 교체·재색인 없음)**
- **재정렬: Cohere `rerank-v3.5` (검색 뒤 별도 단계, 임베딩과 무관)**
- **법령: korean-law MCP (법제처 법령·판례 실시간 조회 + 인용 검증)**
- Vercel Pro + Fluid Compute · Node 런타임 고정 (Edge 미사용)

## 명령어

```
pnpm dev          # 로컬 개발 서버
pnpm build        # 프로덕션 빌드 (CI에서 검증 기준)
pnpm typecheck    # tsc --noEmit
pnpm lint         # next lint
pnpm db:push      # Supabase 마이그레이션 적용
pnpm db:reset     # DB 초기화
```

테스트 셋업 없음 (PoC 단계). 동작 검증은 `pnpm build` + 로컬 `pnpm dev`로 직접 호출.

환경변수는 `.env.local`(로컬) / Vercel(원격). `lib/env.ts`에서 zod로 검증되며, 누락 시 부팅 실패. 필요 키: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`(임베딩), `COHERE_API_KEY`(재정렬), `ANTHROPIC_API_KEY`(LLM), `LAW_GO_KR_API_KEY`(법제처). 임베딩 모델: `EMBEDDING_MODEL=text-embedding-3-small`, `EMBEDDING_DIMENSIONS=1024`.

## 아키텍처 핵심

진입점은 `app/api/*/route.ts`. 도메인 로직은 `lib/`에 모이고, App Router는 thin handler만.

- `app/api/chat` → `lib/ai`(OpenAI 임베딩 · Cohere 재정렬 · Claude LLM) + `lib/db/search.ts`(hybrid_search / regulation_search RPC). 흐름: 내부 규정 검색 → Cohere Rerank → 관련도 분기(기준치 이상=내부 규정 근거 / 미만=korean-law MCP 법령 조회 + 인용 검증) → Claude 스트리밍. `query_log` 비동기 적재(관리자 로그 원천). ※ 오픈 전 하드닝 필요: 로그인 게이트·레이트리밋·에러 일반화(`docs/07` 참조).
- `app/api/ingest` → 64건 단위 배치 임베딩 후 `documents` 적재. ※ 외부 노출 금지 — 관리자 전용/스크립트 전용화 대상.
- `app/api/cron/*` → Vercel Cron으로 ② 크롤러 / 법령 캐시 갱신.
- `app/api/duplicate-check` → ③ 중복수혜 (placeholder, 선택 기능).

`lib/` 모듈 경계:

| 모듈 | 역할 |
|---|---|
| `lib/ai/` | OpenAI(임베딩) + Cohere(재정렬) + Anthropic(Claude) + 프롬프트. 답변 LLM은 Claude Sonnet 4.6 단독. |
| `lib/db/` | Supabase admin/anon 클라이언트 + `hybrid_search` / `regulation_search` RPC 래퍼. |
| `lib/law/` | 법제처 법령·판례 조회는 **korean-law MCP** 사용 + `law_cache` 캐싱. 인용 검증으로 환각 차단. |
| `lib/crawler/` | ② 정적 HTML fetch + cheerio + AI 비R&D 판별. JS 렌더링 필요 사이트만 외부 스크래핑 도입 검토. |
| `lib/ocr/` | ③ 비정형 문서 표준화 (선택). |
| `lib/env.ts` | zod 환경변수 검증 (boot guard). |

스키마 진실원은 `supabase/migrations/`. 데이터 모델 변경 시 마이그레이션 신규 추가가 원칙(기존 수정 금지). 핵심 테이블: `documents`, `regulation`, `query_log`, `law_cache`, `announcements`, `crawler_sources`, `crawl_runs`, `project_history`, `project_embeddings`, `duplicate_check_runs`. `documents`·`regulation` 임베딩은 OpenAI 1024d. 모든 테이블 RLS enable + `service_role` 외 명시 정책.

## 핵심 설계 결정 (변경 시 docs 갱신 필요)

| 결정 | 근거 |
|---|---|
| LLM은 **상용 API만 사용** | PoC 인프라 단순화. 자체 호스팅 / 내부 모델 제안 금지. |
| Claude Sonnet 4.6 단독 | 1M context, adaptive thinking, Opus 대비 1.67× 저렴 |
| 임베딩 OpenAI 고정 | 색인=쿼리 동일 모델·차원 필수. 영구 OpenAI(교체·재색인 없음). Cohere는 재정렬 전용 |
| 법령은 korean-law MCP | 법제처 공식·실시간 조회 + 인용 검증으로 환각 차단. 우리가 복사·보관하지 않음 |
| pgvector + tsvector + RRF | Pinecone 등 별도 인프라 불필요, Supabase 내 완결 |
| `vector(1024)` + HNSW | 2026 pgvector 권장, OpenAI text-embedding-3-small 차원 |
| Node 런타임 고정 | Anthropic/OpenAI/Cohere SDK가 Node API 의존 |

## docs/ 인덱스

| 파일 | 내용 |
|---|---|
| `00-overview.md` | 프로젝트 정체성·일정·민감도 분류 |
| `01-architecture.md` | 시스템 다이어그램 + 스택 결정 근거 표 |
| `03-data-model.md` | 테이블 컬럼/인덱스 명세 |
| `04-feature-advisor.md` | ① 어드바이저 RAG 파이프라인(관련도 분기·법령 MCP) |
| `05-feature-crawler.md` | ② 공모사업 크롤러 설계 (8월 예정) |
| `07-security-ops.md` | 보안·운영·키 관리·하드닝 정책 |

## Git 사용

- 단순 `git pull` / `git push`로 작업한다. **PR 생성·브랜치 분기·머지 자동화 없음.**
- "git pull" → `git pull`로 main 최신화.
- "git push" → (필요 시) 커밋 후 `git push`. push 전 `pnpm run build` 통과 권장, 빌드 실패 시 중단·보고.
- **금지**: `git push --force`(명시 요청 시만), `--no-verify`, `node_modules/`/`.env*` 커밋.

## PoC 운영 정책

- **라이트 셋업 기본**. 협업/CI/보호 규칙 제안 시 기업 풀 셋업을 자동 적용하지 말 것. CODEOWNERS·PR 템플릿·1명 승인 강제·conversation resolution 등은 사고 발생 후 점진 도입.
- **불필요한 추상화·미래 가설 코드 금지.** 한 가지 변경 = 한 가지 커밋, 한 가지 PR.
- **테스트/검증은 `pnpm build` 통과 기준.** 추가 정합성 확인은 사용자 명시 요청 시.
- **DB 스키마 변경은 단독 PR.** 기능 변경과 묶지 않는다.
- **용어**: 공모 aggregator는 항상 "공모지원사업" / "공모사업". "채용"으로 부르지 말 것.
