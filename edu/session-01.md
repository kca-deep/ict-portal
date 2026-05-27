# 1회차 - Supabase 연결 + 매뉴얼/지침 vectorDB 색인

| 항목 | 내용 |
|------|------|
| 날짜 | 2026-05-27 (수, KST) |
| 소속 모듈 | M0 + M1 + M2 (일부 압축) |
| 소요시간 | 3시간 |
| 다음 회차 | 2회차 (6/9 화) - hybrid_search RPC 호출 + 결과 분석 |

---

## 회차 목표

- Supabase 클라우드 프로젝트 생성 및 5개 마이그레이션 적용
- supabase CLI / MCP / `/supabase` Skill 세 경로로 Supabase를 다루는 방법 익히기
- `data/manuals/`의 PDF 매뉴얼을 kordoc MCP로 파싱 → OpenAI 임베딩 → `documents` 테이블에 색인
- 색인 결과를 MCP로 검증

---

## 완료 기준

- `supabase migration list`에 5개 마이그레이션 Applied 표시
- MCP로 `documents` 테이블 스키마 조회 성공
- kordoc MCP가 PDF를 마크다운으로 변환해 `data/manuals/parsed/` 에 저장됨
- 매뉴얼 1건 이상이 청킹·임베딩되어 `documents` 테이블에 적재됨
- MCP `SELECT count(*)`로 적재 건수 확인 가능

---

## 사전 준비물

| 항목 | 비고 |
|------|------|
| Node.js 20+, pnpm | `pnpm -v`로 확인 |
| Supabase 계정 | GitHub 로그인 권장, Free tier |
| OpenAI API 키 | https://platform.openai.com/api-keys |
| 색인할 매뉴얼/지침 파일 | `.pdf` 1~3개, `data/manuals/` 폴더에 배치 |
| kordoc MCP 연결 | Claude Code에 kordoc MCP가 등록·인증되어 있어야 함 (PDF 파싱용) |
| Claude Code CLI | 설치 및 로그인 완료 |
| Anthropic / Cohere API 키 | 오늘은 불필요 (Cohere는 2회차 Rerank부터) |

---

## Part 1. 환경 + 도구 설치 (30분)

### 1-1. 기본 확인 (5분)

```powershell
node -v       # v20 이상
pnpm -v
git --version
```

### 1-2. supabase CLI 설치 (Windows / 15분)

PowerShell:
```powershell
# scoop 미설치 시 먼저 설치
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
irm get.scoop.sh | iex

# supabase CLI
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
supabase --version
```

대안: https://github.com/supabase/cli/releases 에서 `supabase_windows_amd64.tar.gz` 다운로드 → 압축 해제 → PATH 등록.

### 1-3. Supabase MCP 인증 (5분)

Claude Code에서:
> "Supabase MCP에 인증해줘."

브라우저 OAuth 승인 → 토큰 자동 저장.

### 1-4. `/supabase` Skill 확인 (5분)

Claude Code 입력창에 `/supabase` 입력 → 명령어 목록 확인.

---

## Part 2. Supabase 프로젝트 생성 + 마이그레이션 적용 (60분)

### 2-1. 클라우드 프로젝트 생성 (15분)

1. https://supabase.com → GitHub 로그인
2. New project
3. Region: `Northeast Asia (Seoul)`
4. DB password: 1Password 등에 저장 (분실 시 재설정 필요)
5. Plan: Free

### 2-2. `.env.local` 작성 (10분)

대시보드 **Project Settings → API**에서 키 3개 복사:

```env
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

OPENAI_API_KEY=sk-...
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1024
```

`.gitignore`에 `.env.local`이 포함되어 있는지 확인.

> `SUPABASE_SERVICE_ROLE_KEY`는 서버 코드(`app/api/*`, `lib/db/*`, `scripts/*`)에서만 사용. 클라이언트 컴포넌트 import 금지.

### 2-3. CLI로 link → db push (25분)

```powershell
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db push
supabase migration list
```

`PROJECT_REF`는 대시보드 URL `https://supabase.com/dashboard/project/<여기>` 값.

Local/Remote 모두에 5개 마이그레이션이 표시되면 성공.

에러 시 Claude Code 지시:
> "`supabase db push` 결과 다음 에러가 났어: [에러 로그]. 원인과 다음 조치를 알려줘."

자주 발생하는 케이스:
- vector 확장 권한 → 대시보드 SQL Editor에서 먼저 실행:
  ```sql
  create extension if not exists vector with schema extensions;
  ```

### 2-4. MCP로 스키마 검증 (10분)

Claude Code 지시:
> "Supabase MCP로 `public.documents` 테이블의 컬럼·인덱스·RLS 정책을 보여줘. `extensions.vector` 확장도 확인."

확인 항목:
- `embedding extensions.vector(1024)` 컬럼 존재
- HNSW + GIN 인덱스 생성됨
- RLS enabled + `documents_select_authenticated` 정책

---

## Part 3. 매뉴얼/지침 vectorDB 색인 (75분)

### 3-0. RAG 검색 전체 흐름과 오늘의 위치 (10분)

RAG 검색은 3단계로 구성된다.

| 단계 | 시점 | 사용 모델 | 짝이 맞아야 하는 대상 |
|---|---|---|---|
| ① 문서 색인 임베딩 | 사전 작업 (오늘) | OpenAI `text-embedding-3-small` (1024d) | — |
| ② query 임베딩 | 사용자 질의 시 매번 | OpenAI `text-embedding-3-small` (1024d) | ①과 **반드시 동일** |
| ③ Rerank | ② 결과 후보 30건 대상 | Cohere `rerank-v4.0` | 무관 (벡터 아닌 텍스트 입력) |

흐름도:
```
[색인 시점 — 1회차, 오늘]
매뉴얼 텍스트 ── OpenAI 임베딩 ──► 벡터 ──► documents 테이블 저장

[검색 시점 — 2회차 이후]
사용자 질문 ── OpenAI 임베딩 ──► query 벡터
                                  │
                                  ▼
                       pgvector 거리 검색 → 후보 30건 (텍스트)
                                  │
                                  ▼
                Cohere Rerank API (query 텍스트 + 후보 텍스트)
                                  │
                                  ▼
                               상위 8건
```

규칙:
- **임베딩 모델 종속성**: 색인(①)과 query(②)는 같은 모델·같은 차원이어야 한다. 다르면 벡터 공간이 어긋나 1차 검색이 깨진다.
- **Rerank 독립성**: Rerank(③)는 벡터를 보지 않고 query/후보 **원문 텍스트**로 cross-encoder 채점을 한다. 따라서 임베딩 모델이 OpenAI여도 Rerank는 Cohere/Voyage로 자유롭게 조합 가능.
- 결론: "OpenAI 임베딩 + Cohere Rerank" 조합은 정상 동작한다. 단 2회차에서 query 임베딩 시 반드시 `text-embedding-3-small` + `dimensions=1024`를 그대로 사용해야 한다.

오늘 1회차는 **① 단계만** 수행한다. ②③은 2회차에서 진행.

### 3-1. PDF 매뉴얼 배치 (5분)

`data/manuals/` 폴더 생성 후 색인 대상 PDF 파일 복사:
```
data/manuals/
  ├─ 운영규정.pdf
  ├─ 사업비집행지침.pdf
  └─ 정산매뉴얼.pdf
```

### 3-2. kordoc MCP로 PDF 파싱 (15분)

PDF는 그대로 임베딩할 수 없으므로 먼저 텍스트(마크다운)로 추출해야 한다. kordoc MCP는 한국어 문서(PDF/HWP/HWPX) 구조를 보존하면서 마크다운으로 변환해 준다.

사용할 kordoc 도구:
- `parse_document` : 문서 전체를 마크다운으로 변환
- `parse_table` : 표 영역을 마크다운 표로 변환 (필요 시)
- `parse_metadata` : 제목·작성일 등 메타데이터 추출 (선택)

Claude Code 지시:
> "kordoc MCP `parse_document`로 `data/manuals/` 안의 모든 PDF를 마크다운으로 변환해서 `data/manuals/parsed/<원본파일명>.md` 로 각각 저장해줘. 표가 포함된 페이지가 있으면 `parse_table`로 별도 변환해서 같은 마크다운에 합쳐도 좋아. 변환 결과 파일별 글자 수와 줄 수를 한 줄씩 요약해서 보여줘."

확인 항목:
- `data/manuals/parsed/*.md` 파일이 PDF 개수만큼 생성됨
- 마크다운 내용을 직접 열어 본문이 깨지지 않고 들어왔는지 점검 (특히 표·번호 항목)

### 3-3. 색인 스크립트 작성 (20분)

사전 패키지 설치:
```powershell
pnpm add openai
pnpm add -D tsx
```

Claude Code 지시:
> "`scripts/ingest-manuals.ts`를 만들어줘. 요구사항:
> - `data/manuals/parsed/` 폴더의 모든 `.md` 파일을 읽는다 (kordoc이 변환한 결과물)
> - 각 파일을 500자 단위로 청킹 (문단/줄바꿈 경계 우선)
> - 각 청크를 OpenAI `text-embedding-3-small` 모델로 임베딩 (`dimensions: 1024`)
> - `documents` 테이블에 INSERT:
>   - `source = 'internal_regulation'`
>   - `title = 파일명(확장자 제외)`
>   - `content = 청크 텍스트`
>   - `chunk_index = 순번`
>   - `metadata = { source_file: '<원본PDF명>.pdf', parsed_from: 'kordoc' }`
>   - `embedding = 임베딩 배열`
> - `lib/db/supabase.ts`의 `getSupabaseAdmin()` 재사용
> - OpenAI SDK는 `openai` 패키지 사용, API 키는 `process.env.OPENAI_API_KEY`
> - 임베딩은 배치(한 번에 32청크)로 호출해 API 호출 수 절감
> - 진행 상황을 콘솔에 출력 (`[파일명] 청크 N개 색인 완료`)
> - `pnpm tsx scripts/ingest-manuals.ts`로 실행 가능하게"

### 3-4. 실행 + 확인 (15분)

```powershell
pnpm tsx scripts/ingest-manuals.ts
```

에러 시 Claude Code에 에러 로그 그대로 전달하여 수정 요청.

자주 발생하는 케이스:
- OpenAI 401 Unauthorized → `.env.local`의 `OPENAI_API_KEY` 값과 결제 카드 등록 여부 확인
- OpenAI 429 rate limit → 배치 크기 축소(32 → 16) 또는 청크 간 짧은 sleep
- vector 차원 불일치 → OpenAI 호출 시 `dimensions: 1024` 파라미터 누락 여부 확인 (기본값은 1536)
- RLS에 막힘 → `service_role` 키를 사용 중인지 확인 (`getSupabaseAdmin`)
- kordoc 변환 결과가 비어있거나 깨짐 → 원본 PDF가 스캔본(이미지)일 가능성. OCR 필요한 PDF는 오늘 범위 외 (별도 처리)

### 3-5. MCP로 색인 결과 확인 (10분)

Claude Code 지시:
> "Supabase MCP로 `documents` 테이블의 총 행 수, source별 카운트, 그리고 최근 INSERT된 청크 3건을 보여줘 (id, title, chunk_index, content 앞 100자)."

---

## Part 4. 마무리 (15분)

### 4-1. 간단 검색 동작 확인 (10분)

Claude Code 지시:
> "Supabase MCP로 `documents`에서 `fts @@ plainto_tsquery('simple', '사업비')` 조건으로 SELECT 해서 결과 5건만 보여줘."

→ BM25(tsvector) 기반 키워드 검색이 동작함을 확인. 벡터 검색은 2회차에서.

### 4-2. `/supabase` Skill로 RLS 검토 (5분)

Claude Code 지시:
> "`/supabase` 스킬로 `supabase/migrations/20260520000002_documents_table.sql`의 RLS 정책을 평가해줘."

---

## 2회차 예고

RAG 3단계 중 **② query 임베딩 + 1차 검색**, **③ Rerank**를 구현한다.

- **② query 임베딩 + 1차 검색**
  - `lib/ai/embedding.ts`의 `embedQuery()`가 OpenAI `text-embedding-3-small` + `dimensions=1024`를 사용하는지 확인 (오늘 색인과 동일해야 함)
  - `lib/db/search.ts`의 `hybrid_search` RPC 호출 → BM25 + pgvector + RRF 결합 후보 30건 반환
- **③ Rerank**
  - Cohere `rerank-v4.0` 도입 → 후보 30건 → 상위 8건 재정렬
  - 대안: Voyage `rerank-2.5` (OpenAI/Anthropic은 Rerank API 미제공)
