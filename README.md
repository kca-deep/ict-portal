# PIMS — ICT기금 사용자 중심 AX서비스

> 본 저장소 = Next.js 프로젝트 루트. 자세한 기획은 [`docs/`](./docs/00-overview.md) 참고.

## 한 줄 요약

ICT기금 규정·법령 어드바이저(RAG) + 공모사업 크롤링 + 중복수혜 조회를 **단일 Next.js 앱**에 통합. **Vercel + Supabase pgvector + Cohere(임베딩·리랭킹) + Claude Sonnet 4.6** 스택.

## 디렉토리

```
.
├── app/                      Next.js App Router
│   ├── (admin)/              관리자 페이지 (placeholder)
│   ├── api/
│   │   ├── chat/             ① 어드바이저 RAG
│   │   ├── ingest/           문서 색인
│   │   ├── duplicate-check/  ③ 중복수혜 (placeholder)
│   │   ├── cron/             ② 크롤러 / 캐시 갱신 (placeholder)
│   │   └── health/
│   └── layout.tsx · page.tsx · globals.css
├── lib/
│   ├── ai/                   embedding · rerank · llm-router · prompts
│   ├── law/                  법령 도구 (자체 Tool Use, placeholder)
│   ├── crawler/              공모 크롤러 (placeholder)
│   ├── ocr/                  비정형 문서 표준화 (placeholder)
│   ├── db/                   Supabase 클라이언트 + hybrid search
│   └── env.ts                zod 환경변수 검증
├── supabase/
│   ├── config.toml
│   └── migrations/           5개 작성됨 (① 어드바이저용), ②③용 추가 예정
├── docs/                     기획문서 8개 (00~07)
├── 붙임3. 사업계획서(...).hwpx        원본 기획서
├── parse_hwpx.py             hwpx 파싱 헬퍼
├── package.json · tsconfig.json · next.config.ts
├── tailwind.config.ts · postcss.config.mjs
├── vercel.json · .env.example · .gitignore
```

## 셋업

```bash
# 1) 의존성
pnpm install

# 2) 환경변수
cp .env.example .env.local
# 키 채우기 (.env.example의 모든 항목)

# 3) Supabase 마이그레이션 적용 (Supabase CLI + 프로젝트 link 필요)
pnpm db:push

# 4) 로컬 실행
pnpm dev
```

필요한 외부 키:
- **Supabase**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **Anthropic**: `ANTHROPIC_API_KEY` (기본 모델 `claude-sonnet-4-6`)
- **Cohere**: `COHERE_API_KEY` (임베딩 + 리랭커 공용)
- **법제처**: `LAW_GO_KR_API_KEY` (`open.law.go.kr` 가입 후 발급)

## 현재 구현 상태

| 영역 | 상태 |
|---|---|
| 기획 문서 (`docs/`) | ✅ 완료 (00~07) |
| 폴더 구조 | ✅ 확정 |
| ① 어드바이저 — RAG 코어 (`app/api/chat`, `lib/ai/`, `lib/db/`) | ✅ 골격 작성 |
| ① 어드바이저 — 법령 Tool Use (`lib/law/`) | ⏳ placeholder (5~7월) |
| ② 크롤러 (`lib/crawler/`, `app/api/cron/`) | ⏳ placeholder (8~9월) |
| ③ 중복수혜 (`lib/ocr/`, `app/api/duplicate-check/`) | ⏳ placeholder (10~11월) |
| Supabase 마이그레이션 | ① 5개 작성 / ②③ 미작성 |

## API (현재 구현)

### `POST /api/chat`

```json
{
  "query": "사업비 집행 증빙서류는?",
  "session_id": "uuid (옵션)",
  "user_id": "uuid (옵션)"
}
```

`text/plain` 스트리밍 응답. `query_log`에 비동기 적재.

### `POST /api/ingest`

```json
{
  "documents": [
    {
      "source": "internal_regulation",
      "doc_type": "운영규정",
      "title": "사업비 집행 지침 제3장",
      "content": "...",
      "source_ref": "ICT-OP-2025-003",
      "metadata": { "chapter": "제3장", "article": "제12조" }
    }
  ]
}
```

64건 단위 배치 임베딩 후 적재.

### `GET /api/health`

Supabase 연결 확인.

## 핵심 설계 결정 (요약)

| 항목 | 결정 | 근거 |
|---|---|---|
| LLM | Claude Sonnet 4.6 단독 | 1M context, adaptive thinking, Opus 대비 1.67× 저렴 |
| 임베딩 / 리랭킹 | Cohere `embed-v4` (1024d) / `rerank-v4` | 한국어 SOTA, 다국어 명시 지원 |
| Vector DB | Supabase pgvector + tsvector (Hybrid Search + RRF) | RLS·Auth 통합, 별도 인프라 불필요 |
| 법령 도구 | **Claude Tool Use 자체 구현** (`lib/law/`) | Anthropic 단독이므로 MCP 표준 가치 ↓. 외부 fork 의존성 0 |
| 호스팅 | Vercel Pro + Fluid Compute (maxDuration 300s) | RAG 응답시간 충분, Cron으로 크롤러 운영 |
| 런타임 | Node.js (Edge ❌) | Anthropic / Cohere SDK가 Node API 의존 |

자세한 결정 근거는 [`docs/01-architecture.md`](./docs/01-architecture.md) 참고.

## 다음 단계

1. **법령 도구 구현** (`lib/law/`) — `search_law`, `get_law_article`, `verify_citation` 3개부터 (MVP)
2. **Supabase 프로젝트 셋업 + 마이그레이션 적용**
3. **평가 셋 작성** — ICT기금 운영팀 골든 Q&A 50~100건
4. **PoC 평가** — Retrieval Recall@8, Citation 검증율, 응답시간 측정
5. (이후) ② 크롤러 → ③ 중복수혜 PoC

## 라이선스

내부 PoC. 외부 공개 시 라이선스·법무 검토 후 결정.
