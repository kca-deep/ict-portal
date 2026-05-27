# PIMS 바이브코딩 교육 커리큘럼

> 작성일: 2026-05-21 (일정 갱신: 2026-05-27, 부서 발송 메일 기준 정합)  
> 대상: 비전문가 (개발 경험 없거나 최소 수준)  
> 방식: 바이브코딩 - Claude Code를 주 도구로 사용하여 코드를 생성/수정/확인하는 방식  
> 일정: 매주 화·수 3시간 (KST), **총 25회차**. **6/2(화), 6/3(수) 휴강**  
> 기간 요약  
> - 5월~6월: 기반 환경·데이터 계층·AI 검색 파이프라인 학습·구축 (1~8회차)  
> - 7월: LLM 통합·채팅 UI·배포 → **7월 말 AI 챗봇 완성 (17회차, 7/29)**  
> - 8월: 공모사업 크롤러 → **8월 말 완성 (24회차, 8/25)**  
> - 8월 이후: 중복수혜 조회 PoC (선택)

---

## 기능 우선순위

| 기능 | 완성 목표 | 비고 |
|------|-----------|------|
| (1) AI 챗봇 (규정법령 어드바이저) | **7월 말 (17회차, 7/29) 필수** | RAG 파이프라인 + Tool Use + 스트리밍 UI |
| (2) 크롤러 (공모사업 파이프라인) | **8월 말 (24회차, 8/25)** | 챗봇 완성 후 시작 |
| (3) 중복수혜 조회 | 8월 이후 선택 (25회차~) | 일정 내 완성 안 해도 됨 |

---

## 학습 기술 목록

| 분류 | 기술 |
|------|------|
| 런타임 | Node.js 20, pnpm |
| 언어 | TypeScript (최소 문법 위주) |
| 프레임워크 | Next.js 15 App Router |
| 데이터베이스 | Supabase Postgres, pgvector, tsvector |
| 문서 파싱 | kordoc MCP (PDF/HWP/HWPX → 마크다운) |
| 임베딩 | OpenAI text-embedding-3-small (`dimensions=1024`). 대안: Cohere embed-v4.0, Voyage voyage-4 — 모두 1024d 호환 |
| 리랭킹 | Cohere rerank-v4.0. 대안: Voyage rerank-2.5. **OpenAI·Anthropic은 리랭킹 API 미제공** → Cohere/Voyage 중 양자택일 필수 |
| LLM | Anthropic Claude Sonnet 4.6, Tool Use 패턴 |
| 크롤링 | fetch + cheerio |
| 스타일 | Tailwind CSS |
| 배포 | Vercel (Pro + Fluid Compute, Cron) |
| AI 코딩 도구 | Claude Code CLI + Supabase MCP + kordoc MCP |

---

## 모듈 구성

### 모듈 0 - 기반 환경 구축 (1회차 + 후속 회차에 분산)

- 개발 환경 설치: Node.js, pnpm, Claude Code CLI, supabase CLI
- Supabase MCP / kordoc MCP / `/supabase` Skill 인증·점검
- Next.js 15 App Router 파일 규칙 (page/route/layout)
- 환경변수(.env.local) 구성과 server-only vs public

### 모듈 1 - 데이터 계층 (1, 7회차)

- Supabase 클라우드 프로젝트 생성 및 CLI link
- SQL 마이그레이션 실행: pgvector extension, documents/query_log/law_cache 테이블
- Row Level Security(RLS)와 service_role 패턴
- MCP로 스키마·정책 검증

### 모듈 2 - AI 검색 파이프라인 (1~8회차)

- kordoc MCP로 PDF 매뉴얼 → 마크다운 변환
- 텍스트 청킹 및 OpenAI 임베딩 호출 (1024d)
- documents 테이블 색인 스크립트 작성/실행
- hybrid_search 실행: BM25 + pgvector + RRF 결합
- Cohere Rerank: 30건 → 상위 8건 재정렬
- /api/ingest Route Handler화 + 입력 검증/오류 처리
- 청킹 파라미터 튜닝 및 검색 품질 평가

### 모듈 3 - LLM 통합 & Tool Use (9~13회차)

- Anthropic SDK `messages.stream`: 스트리밍 응답
- 시스템 프롬프트 설계 + `cache_control` 프롬프트 캐싱
- Tool Use 패턴: tools 정의 → tool_use 처리 → tool_result 반환 → 재호출 루프
- lib/law/ 도구 3개: `search_law`, `get_law_article`, `verify_citation`
- law_cache 테이블 캐싱 연결

### 모듈 4 - 채팅 UI & end-to-end 통합 (14~15회차)

- Next.js Route Handler에서 `ReadableStream` 반환
- Vercel AI SDK `useChat` 훅: 프론트엔드 스트리밍 수신
- 채팅 UI 컴포넌트 구현 (Tailwind CSS)
- end-to-end 흐름 연결: 질의 → 검색 → LLM → 스트리밍 → 화면
- query_log 비동기 적재 (fire-and-forget)

### 모듈 5 - 배포 & AI 챗봇 최종 완성 (16~17회차)

- Vercel 배포 설정: vercel.ts/json, 환경변수 등록
- Vercel Fluid Compute maxDuration 설정
- Supabase Auth 기초 + 로그인 페이지
- RLS 정책 최종 확인
- 실제 URL에서 챗봇 작동 검증 → **AI 챗봇 완성**

### 모듈 6 - 크롤러 파이프라인 (18~24회차)

- Vercel Cron + Route Handler 패턴
- fetch + cheerio: HTML 파싱
- crawler_sources 테이블 설계
- /api/cron/crawl-announcements 파이프라인
- Claude로 공고 분류(is_ict_fund, category)
- announcements 테이블 INSERT/UPSERT + 임베딩 연결
- 다중 사이트 확장 + 안정화

### 모듈 7 - 중복수혜 조회 PoC (선택, 25회차 이후)

- PDF/이미지 파싱 및 텍스트 추출
- project_history 임베딩 생성 및 색인
- 임베딩 코사인 유사도 기반 중복 판별 로직
- 민감 데이터(사업자번호, 인건비) 마스킹 정책
- duplicate_check_runs 결과 저장 및 관리자 UI

---

## 회차별 일정

> 매주 화·수, 한국 시간. 6/2(화), 6/3(수) 휴강.

| 회차 | 날짜 | 요일 | 모듈 | 회차 제목 | 이 회차 완료 시 상태 |
|------|------|------|------|-----------|-------------------|
| 1 | 5/27 | 수 | M0+M1+M2 | Supabase 연결 + kordoc MCP로 PDF 파싱 + OpenAI 임베딩 색인 | 5개 마이그레이션 적용, PDF→마크다운 변환, documents 테이블에 매뉴얼 청크 색인 완료 |
| — | 6/2 | 화 | — | (휴강) | — |
| — | 6/3 | 수 | — | (휴강) | — |
| 2 | 6/9 | 화 | M2 | hybrid_search RPC 호출 + 결과 분석 | BM25+pgvector+RRF 결합 결과 30건 반환 확인 |
| 3 | 6/10 | 수 | M2 | Cohere Rerank 도입 + 결과 비교 | 후보 30건 → 상위 8건 재정렬, Rerank 전/후 품질 비교 |
| 4 | 6/16 | 화 | M2 | 텍스트 청킹 파라미터 튜닝 | chunk size, overlap 변화에 따른 검색 품질 비교 |
| 5 | 6/17 | 수 | M0+M2 | App Router 정리 + /api/ingest Route Handler화 | 색인 트리거를 API로 호출, 입력 검증/오류 처리 추가 |
| 6 | 6/23 | 화 | M2 | 추가 매뉴얼 색인 + metadata 확장 | 다양한 source 종류 색인, metadata 필터 검색 동작 |
| 7 | 6/24 | 수 | M1+M2 | Supabase RLS + service_role 패턴 심화 | 정책 분리, 사용자 권한별 접근 동작 확인 |
| 8 | 6/30 | 화 | M2 | 검색 품질 평가 + 6월 마무리 | 평가 질의셋 작성, top-k 정확도 측정 |
| 9 | 7/1 | 수 | M3 | Anthropic SDK 스트리밍 + 시스템 프롬프트 기초 | 도구 없이 Claude 질의응답 스트리밍 동작 |
| 10 | 7/7 | 화 | M3 | 프롬프트 캐싱 + 시스템 프롬프트 고도화 | `cache_control` 적용, 토큰 비용 감소 확인 |
| 11 | 7/8 | 수 | M3 | Tool Use 기초 패턴 | 간단 도구로 tool_use → tool_result 루프 동작 |
| 12 | 7/14 | 화 | M3 | `search_law` 도구 구현 | 법제처 OpenAPI 연동, 법령 검색 결과 반환 |
| 13 | 7/15 | 수 | M3 | `get_law_article` + `verify_citation` + law_cache | 법령 조문 조회·인용 검증·캐싱 통합 |
| 14 | 7/21 | 화 | M4 | Route Handler ReadableStream + useChat 훅 | 프론트엔드에서 실시간 텍스트 수신 |
| 15 | 7/22 | 수 | M4 | 채팅 UI + end-to-end 통합 + query_log | 질의 → 검색 → LLM → 화면 출력 전체 흐름 |
| 16 | 7/28 | 화 | M5 | Vercel 배포 + 환경변수 등록 + Fluid Compute 설정 | 프리뷰 배포 URL에서 챗봇 동작 |
| 17 | 7/29 | 수 | M5 | Supabase Auth + RLS 최종 확인 + 프로덕션 배포 | 외부 URL에서 챗봇 접속 ✅ **AI 챗봇 완성** |
| 18 | 8/4 | 화 | M6 | 크롤러 구조 설계 + Vercel Cron 패턴 | Cron 등록, 빈 라우트 골격 호출 확인 |
| 19 | 8/5 | 수 | M6 | fetch + cheerio HTML 파싱 + crawler_sources 설계 | 1개 사이트 HTML 가져와 셀렉터로 추출 |
| 20 | 8/11 | 화 | M6 | /api/cron/crawl-announcements 파이프라인 + 1개 사이트 수집 | crawl_runs 적재, 1건 공고 INSERT 확인 |
| 21 | 8/12 | 수 | M6 | Claude LLM으로 공고 분류 (is_ict_fund, category) | 분류 정확도 sampling 검증 |
| 22 | 8/18 | 화 | M6 | announcements 임베딩 + hybrid_search 확장 | 공고 본문 임베딩 색인, 검색 동작 |
| 23 | 8/19 | 수 | M6 | 다중 사이트 확장 + UPSERT 로직 | 여러 기관 동시 크롤링, 중복 방지 |
| 24 | 8/25 | 화 | M6 | 안정화 + 자동 적재 검증 | Cron 자동 실행, 실패 처리 ✅ **크롤러 완성** |
| 25 | 8/26 | 수 | M7 | 중복수혜 조회 PoC 시작 (선택) | 일정 여유 시 진행 |

### 일정 리스크

- **1회차 (M0+M1+M2 압축 부트스트랩)**: 환경/도구 설치 + Supabase + 매뉴얼 색인을 한 회차에 압축. 외부 서비스 인증/설치 지연 시 영향이 가장 큼. 미완 시 2~3회차 앞부분에 잔여 작업 흡수
- **11~13회차 (LLM Tool Use)**: 가장 난이도가 높은 개념. 이해 흐름에 따라 14회차로 일부 이월 가능
- **16~17회차 (배포 + Auth)**: 환경변수·도메인·OAuth 설정 이슈 가능. 7월 말 챗봇 완성을 위해 이 두 회차에서 막힘이 없도록 사전 점검 필요

---

## 세션 구성 원칙

- 각 세션(3시간): 이론 설명 1시간 + Claude Code 실습 2시간
- 실습은 Claude Code로 코드 생성 → 수강생이 결과 확인하고 수정 요청하는 방식
- TypeScript, React 문법 강의에 시간을 소모하지 않음. 코드가 실제로 작동하는지 확인하는 데 집중
- 세션 시작 시 이전 회차 결과물 확인, 세션 종료 시 다음 회차 사전 준비 안내
