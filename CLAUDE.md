# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

**PIMS (ICT기금 사용자 중심 AX서비스)** — 단일 Next.js 앱에 3대 기능을 통합한 2인 PoC 프로젝트.

1. **규정·법령 어드바이저** (`①`) — 내부 규정 + 법령 RAG. Hybrid Search + Citation 검증.
2. **공모지원사업 파이프라인** (`②`) — 유관기관 공고 크롤링 + AI 분류 + 통합 제공. (공모/지원사업 aggregator — **채용 공고 아님**.)
3. **중복수혜 조회** (`③`) — 신청 과제 vs 기존 과제 임베딩 유사도 분석 (PoC).

기획·아키텍처 의사결정의 진실원은 `docs/00~07`. 본 파일은 코드 작업용 요약이며, 의사결정 근거가 필요하면 해당 문서를 우선 참조.

## 기술 스택

- Next.js 15 App Router · TypeScript · Tailwind CSS · React 19
- pnpm 9.12 (packageManager 고정) · Node.js 20+
- Supabase Postgres + pgvector(1024d, HNSW) + tsvector + RLS
- Anthropic Claude Sonnet 4.6 (단독, 1M context)
- Cohere `embed-v4.0` / `rerank-v4.0` (한국어 SOTA)
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

환경변수는 `.env.local`(로컬) / Vercel(원격). `lib/env.ts`에서 zod로 검증되며, 누락 시 부팅 실패. 필요 키: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `COHERE_API_KEY`, `LAW_GO_KR_API_KEY`.

## 아키텍처 핵심

진입점은 `app/api/*/route.ts`. 도메인 로직은 `lib/`에 모이고, App Router는 thin handler만.

- `app/api/chat` → `lib/ai`(임베딩·리랭킹·LLM) + `lib/db/search.ts`(hybrid_search RPC). 스트리밍 응답, `query_log` 비동기 적재.
- `app/api/ingest` → 64건 단위 배치 임베딩 후 `documents` 적재.
- `app/api/cron/*` → Vercel Cron으로 ② 크롤러 / 법령 캐시 갱신.
- `app/api/duplicate-check` → ③ 중복수혜 (placeholder).

`lib/` 모듈 경계:

| 모듈 | 역할 |
|---|---|
| `lib/ai/` | Cohere(embed/rerank) + Anthropic(Claude) + 프롬프트. 답변 LLM은 Claude Sonnet 4.6 단독, 평가 후 Opus 라우팅 검토. |
| `lib/db/` | Supabase admin/anon 클라이언트 + `hybrid_search` RPC 래퍼. |
| `lib/law/` | 법제처 OpenAPI + **Claude Tool Use 자체 구현**. MCP fork 의존성 제거 — Anthropic 단독이라 표준 가치 낮음. |
| `lib/crawler/` | ② 정적 HTML fetch + cheerio + AI 비R&D 판별. JS 렌더링 필요 사이트만 외부 스크래핑 도입 검토. |
| `lib/ocr/` | ③ 비정형 문서 표준화 (10~11월). |
| `lib/env.ts` | zod 환경변수 검증 (boot guard). |

스키마 진실원은 `supabase/migrations/`. 데이터 모델 변경 시 마이그레이션 신규 추가가 원칙(기존 수정 금지). 핵심 테이블: `documents`, `query_log`, `law_cache`, `announcements`, `crawler_sources`, `crawl_runs`, `project_history`, `project_embeddings`, `duplicate_check_runs`. 모든 테이블 RLS enable + `service_role` 외 명시 정책.

## 핵심 설계 결정 (변경 시 docs 갱신 필요)

| 결정 | 근거 |
|---|---|
| LLM은 **상용 API만 사용** | PoC 인프라 단순화. 자체 호스팅 / 내부 모델 제안 금지. |
| Claude Sonnet 4.6 단독 | 1M context, adaptive thinking, Opus 대비 1.67× 저렴 |
| 법령 도구 자체 Tool Use | MCP 표준 가치↓ (Anthropic 단독), 외부 fork 의존성 0 |
| pgvector + tsvector + RRF | Pinecone 등 별도 인프라 불필요, Supabase 내 완결 |
| `vector(1024)` + HNSW | 2026 pgvector 권장, Cohere embed-v4 차원 |
| Node 런타임 고정 | Anthropic/Cohere SDK가 Node API 의존 |

## docs/ 인덱스

| 파일 | 내용 |
|---|---|
| `00-overview.md` | 프로젝트 정체성·일정·민감도 분류 |
| `01-architecture.md` | 시스템 다이어그램 + 스택 결정 근거 표 |
| `02-folder-structure.md` | 디렉토리 구조 + 외부 모듈 통합 원칙 |
| `03-data-model.md` | 테이블 9종 컬럼/인덱스 명세 |
| `04-feature-advisor.md` | ① 어드바이저 RAG 파이프라인 |
| `05-feature-crawler.md` | ② 공모사업 크롤러 설계 |
| `06-feature-duplicate.md` | ③ 중복수혜 PoC 설계 |
| `07-security-ops.md` | 보안·운영·키 관리 정책 |
| `08-team-collaboration.md` | 2인 협업 Git 워크플로우 (본 파일과 짝) |

## Git 워크플로우 — 단축 명령 인터페이스

사용자(`bcchung81`)는 Git 비전문가. 자연어 단축 명령으로 작업하며 Claude가 내부 절차를 자동 처리한다. **각 단축 명령은 사용자가 명시했을 때만 발동**. 일반 코드 작업은 평소대로.

| 사용자 입력 | Claude 자동 처리 |
|---|---|
| "git pull해줘" / "최신화" | `git fetch origin` → (main이면) `pull --ff-only`, (작업 브랜치면) `merge origin/main`. **충돌 시 자동 해결 금지, 보고만.** |
| "새 작업: <설명>" | main 최신화 → 브랜치명 추론(`feat/<scope>-<설명>` 등) → 사용자 확정 후 `checkout -b`. |
| "git push해줘" / "올려줘" | (필요 시) 커밋 메시지 제안 + 커밋 → `pnpm run build` → push → PR 생성 → URL 보고. **빌드 실패 시 즉시 중단, push 강행 금지.** |
| "충돌 해결해줘" | 파일별 충돌 분석/해결 → `pnpm run build` 검증 → `merge: main 반영` 커밋 → 사용자에게 "다시 'git push해줘' 시키세요" 안내. |
| "PR 머지해줘" | 머지 의사 한 번 더 확인 → `gh pr merge <#> --squash --delete-branch` → 로컬 main 동기화. |
| "CI 결과" / "빌드 상태" | 현재 PR 빌드 상태 조회. 실패 시 로그 요약. |

### 작동 원칙

- 단축 명령 중 어느 단계가 실패하면 **다음 단계로 진행 금지**, 사용자에게 즉시 보고 + 다음 액션 안내.
- 머지는 사용자 명시 요청 시에만. **자동 머지 금지.**
- 브랜치 네이밍: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/` 접두사.
- 커밋: Conventional Commits, 한국어 메시지 허용.
- 충돌은 로컬에서 해결 (GitHub 웹 conflict editor 금지 — 빌드 검증 불가).
- **금지**: `git push --force` (사용자 명시 요청 시만), `--no-verify`, `main`에 amend/rebase, `node_modules/`/`.env*` 커밋.

## PoC 운영 정책

- **라이트 셋업 기본**. 협업/CI/보호 규칙 제안 시 기업 풀 셋업을 자동 적용하지 말 것. CODEOWNERS·PR 템플릿·1명 승인 강제·conversation resolution 등은 사고 발생 후 점진 도입 (`docs/08-team-collaboration.md` §9 트리거 참조).
- **불필요한 추상화·미래 가설 코드 금지.** 한 가지 변경 = 한 가지 커밋, 한 가지 PR.
- **테스트/검증은 `pnpm build` 통과 기준.** 추가 정합성 확인은 사용자 명시 요청 시.
- **DB 스키마 변경은 단독 PR.** 기능 변경과 묶지 않는다.
- **용어**: 공모 aggregator는 항상 "공모지원사업" / "공모사업". "채용"으로 부르지 말 것.
