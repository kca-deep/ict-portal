# PIMS 바이브코딩 교육 커리큘럼

> 작성일: 2026-05-21  
> 대상: 비전문가 (개발 경험 없거나 최소 수준)  
> 방식: 바이브코딩 - Claude Code를 주 도구로 사용하여 코드를 생성/수정/확인하는 방식  
> 일정: 매주 2회 x 3시간, 총 12~14회차  
> 목표: 6월 말 AI 챗봇(규정법령 어드바이저) 완성, 크롤러는 6~7월, 중복수혜는 선택

---

## 기능 우선순위

| 기능 | 완성 목표 | 비고 |
|------|-----------|------|
| (1) AI 챗봇 (규정법령 어드바이저) | **6월 말 필수** | RAG 파이프라인 + Tool Use + 스트리밍 UI |
| (2) 크롤러 (공모사업 파이프라인) | 6~7월 | 챗봇 완성 후 시작 |
| (3) 중복수혜 조회 | 7월 이후 선택 | 일정 내 완성 안 해도 됨 |

---

## 학습 기술 목록

| 분류 | 기술 |
|------|------|
| 런타임 | Node.js 20, pnpm |
| 언어 | TypeScript (최소 문법 위주) |
| 프레임워크 | Next.js 15 App Router |
| 데이터베이스 | Supabase Postgres, pgvector, tsvector |
| 임베딩 | Cohere embed-v4.0 (1024차원, 다국어) |
| 리랭킹 | Cohere rerank-v4.0 |
| LLM | Anthropic Claude Sonnet 4.6, Tool Use 패턴 |
| 크롤링 | fetch + cheerio |
| 스타일 | Tailwind CSS |
| 배포 | Vercel (Pro + Fluid Compute, Cron) |
| AI 코딩 도구 | Claude Code CLI |

---

## 모듈 구성

### 모듈 0 - 기반 환경 구축 (1주차)

- 개발 환경 설치: Node.js, pnpm, VS Code, Claude Code CLI
- PIMS 프로젝트 전체 구조 탐색
- Next.js 15 App Router: 파일 시스템 라우팅, Route Handler, 서버/클라이언트 컴포넌트 구분
- TypeScript 필수 최소 개념: 타입 어노테이션, interface, async/await
- 환경변수(.env.local) 구성
- Claude Code 바이브코딩 방식 익히기

### 모듈 1 - 데이터 계층 (2주차)

- Supabase 프로젝트 생성 및 연결
- SQL 마이그레이션 실행: pgvector extension, documents/query_log/law_cache 테이블
- hybrid_search SQL 함수 구조 이해 및 실행
- Supabase JS 클라이언트(서버 사이드): RPC 호출 패턴
- Row Level Security(RLS)와 service_role 패턴

### 모듈 2 - AI 검색 파이프라인 (3주차)

- 텍스트 청킹: 문서를 일정 크기 단위로 분할하는 방법
- Cohere embed-v4.0 API 호출: 텍스트 -> 1024차원 숫자 배열 변환
- /api/ingest 구현: 내부 규정 문서 청킹 -> 임베딩 생성 -> Supabase INSERT
- hybrid_search 실행: BM25(tsvector 키워드 검색) + pgvector(벡터 의미 검색) + RRF 결합
- Cohere Rerank API: 검색 결과 30건 -> 상위 8건으로 재정렬

### 모듈 3 - LLM 통합 & Tool Use (4주차)

- Anthropic SDK `messages.stream`: 스트리밍 응답 기본 구현
- 시스템 프롬프트 설계 + `cache_control`을 사용한 프롬프트 캐싱
- Tool Use 패턴: tools 배열 정의 -> Claude의 tool_use 응답 처리 -> tool_result 반환 -> 재호출 루프
- lib/law/ 모듈 핵심 도구 3개 구현: `search_law`, `get_law_article`, `verify_citation`
- law_cache 테이블 캐싱 연결

### 모듈 4 - 채팅 UI & end-to-end 통합 (5주차)

- Next.js Route Handler에서 `ReadableStream` 반환
- Vercel AI SDK `useChat` 훅: 프론트엔드 스트리밍 수신
- 채팅 UI 컴포넌트 구현 (Tailwind CSS)
- end-to-end 흐름 연결 및 확인: 질의 -> 검색 -> LLM -> 스트리밍 출력 -> 화면 렌더링
- query_log 비동기 적재 구현 (fire-and-forget)

### 모듈 5 - 배포 & AI 챗봇 최종 완성 (6주차 전반)

- Vercel 배포 설정: vercel.json, 환경변수 등록
- Vercel Fluid Compute maxDuration 설정
- Supabase Auth 기초 + 로그인 페이지
- RLS 정책 최종 확인
- 실제 URL에서 챗봇 작동 검증 -> **AI 챗봇 완성**

### 모듈 6 - 크롤러 파이프라인 (6주차 후반 ~ 7월)

- Vercel Cron + Route Handler 패턴
- fetch + cheerio: HTML 파싱 기초
- crawler_sources 테이블 데이터 설계
- /api/cron/crawl-announcements 파이프라인 구현
- Claude로 공고 분류(is_ict_fund, category) 구현
- announcements 테이블 INSERT/UPSERT 및 Cohere 임베딩 연결

### 모듈 7 - 중복수혜 조회 PoC (선택, 7월 이후)

- PDF/이미지 파싱 및 텍스트 추출
- project_history 임베딩 생성 및 색인
- 임베딩 코사인 유사도 기반 중복 판별 로직
- 민감 데이터(사업자번호, 인건비) 마스킹 정책
- duplicate_check_runs 결과 저장 및 관리자 UI

---

## 회차별 일정

| 회차 | 날짜(추정) | 모듈 | 회차 제목 | 이 회차 완료 시 상태 |
|------|-----------|------|-----------|-------------------|
| 1 | 5/21 | M0 | 개발 환경 설치 + 프로젝트 구조 탐색 | `pnpm dev` 실행, 프로젝트 파일 구조 설명 가능 |
| 2 | 5/23 | M0 | App Router 구조 + Claude Code 바이브코딩 실습 | API Route 직접 작성, Claude Code로 코드 생성 경험 |
| 3 | 5/26 | M1 | Supabase 연결 + 마이그레이션 실행 | documents 테이블 생성, pgvector 활성화 확인 |
| 4 | 5/28 | M1 | Supabase JS 클라이언트 + hybrid_search 구조 이해 | RPC 호출로 검색 결과 반환 확인 |
| 5 | 6/2 | M2 | 텍스트 청킹 + Cohere 임베딩 호출 | 규정 문서 1개 청킹 -> 임베딩 벡터 생성 확인 |
| 6 | 6/4 | M2 | /api/ingest 완성 + hybrid_search + Rerank 연결 | 실제 문서 색인 완료, 검색 결과 상위 8건 출력 |
| 7 | 6/9 | M3 | Anthropic SDK 스트리밍 + 시스템 프롬프트 | 도구 없이 Claude 질의응답 스트리밍 동작 |
| 8 | 6/11 | M3 | Tool Use 패턴 + 법령 도구 3개 구현 | search_law -> get_law_article -> verify_citation 루프 동작 |
| 9 | 6/16 | M4 | 스트리밍 Route Handler + useChat 훅 | 프론트엔드에서 실시간 텍스트 수신 확인 |
| 10 | 6/18 | M4 | 채팅 UI 완성 + end-to-end 통합 | 질의 -> 검색 -> LLM -> 화면 출력 전체 흐름 동작 |
| 11 | 6/23 | M5 | Vercel 배포 + Auth + 챗봇 최종 완성 | 외부 URL에서 챗봇 접속 가능 [완료] **AI 챗봇 완성** |
| 12 | 6/25 | M6 | 크롤러 파이프라인 구조 + 1개 사이트 수집 | crawl-announcements 라우트 골격, 공고 1건 수집 확인 |
| 13+ | 7월~ | M6 | 크롤러 완성 (다중 사이트, AI 분류, 임베딩) | announcements 테이블 자동 적재 완성 |
| (선택) | 7월 이후 | M7 | 중복수혜 조회 PoC | 일정 여유 시 진행 |

---

## 세션 구성 원칙

- 각 세션(3시간): 이론 설명 1시간 + 실습 2시간
- 실습은 Claude Code로 코드 생성 -> 수강생이 결과 확인하고 수정 요청하는 방식으로 진행
- TypeScript, React 문법 강의에 시간을 소모하지 않음. 코드가 실제로 작동하는지 확인하는 데 집중
- 세션 시작 시 이전 회차 결과물 확인, 세션 종료 시 다음 회차 사전 준비 안내
