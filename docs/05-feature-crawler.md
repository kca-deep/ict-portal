# ② ICT기금 공모사업 파이프라인

> 일정: **2026년 8~9월**. 전담기관·유관기관 공고를 크롤링하여 ICT기금 비R&D 공고를 통합 제공.

## 1. 목표

- 전담기관 + 주요 유관기관(과기정통부, NIPA, IITP 등) 홈페이지의 **공모사업 공고를 주기적으로 자동 수집**.
- **AI로 ICT기금 비R&D 공고만 판별**하여 추출.
- 공고 내용을 **자동 요약 + 카테고리화**하여 사용자 검색·열람 가능한 형태로 제공.

## 2. 입력·출력

- **입력**: 미리 등록된 크롤링 대상(`crawler_sources` 테이블)
- **출력**: `announcements` 테이블에 적재 + 관리자 페이지에서 열람

## 3. 파이프라인 흐름

```
[Vercel Cron: schedule "0 */6 * * *"]
    │  6시간마다 실행
    ▼
[/api/cron/crawl-announcements/route.ts]
    │
    ▼
[Step 1] crawler_sources 에서 enabled=true 인 소스 로드
    │
    ▼  소스별 순차 처리 (또는 병렬 with 동시 한도)
[Step 2] 정적 HTML fetch (lib/crawler/fetch.ts)
    - fetch + cheerio
    - User-Agent: PIMS-Crawler/1.0
    - timeout 10s
    - 실패 시 crawl_runs.status = 'partial'
    │
    ▼
[Step 3] 공고 목록 파싱 (sources.ts의 셀렉터 적용)
    - 목록 페이지 → 공고 ID, 제목, 게시일, 상세 URL 추출
    - 신규 공고(external_id 미존재)만 처리
    │
    ▼
[Step 4] 상세 페이지 fetch + 본문 추출
    - readability 또는 직접 파싱
    - raw_content 저장
    │
    ▼
[Step 5] AI 비R&D 판별 (lib/crawler/classify.ts)
    - Claude Sonnet 4.6 (또는 Haiku 4.5 비용 절감)
    - 분류 결과: is_ict_fund (boolean), category (text)
    │
    ▼
[Step 6] 콘텐츠 지능형 분석 (lib/crawler/normalize.ts)
    - 주요 정보 추출: 지원대상·지원방식·사업분야·금액·접수기간
    - JSON 구조화 → extracted 컬럼
    │
    ▼
[Step 7] 임베딩 생성 (Cohere embed-v4 search_document)
    │
    ▼
[Step 8] announcements INSERT/UPSERT
    │
    ▼
[Step 9] crawl_runs UPDATE (finished_at, status, counts)
```

## 4. 크롤링 대상 (1차 후보)

| 기관 | 사이트 | 비고 |
|---|---|---|
| 과학기술정보통신부 | msit.go.kr | 부처 공고 |
| 정보통신산업진흥원 (NIPA) | nipa.kr | 전담기관 |
| 정보통신기획평가원 (IITP) | iitp.kr | 전담기관 |
| 한국지능정보사회진흥원 (NIA) | nia.or.kr | 유관기관 |
| 한국인터넷진흥원 (KISA) | kisa.or.kr | 유관기관 |
| 중소벤처기업부 | mss.go.kr | ICT 관련 일부 |
| K-Startup | k-startup.go.kr | 통합 창업지원 |

각 사이트별 셀렉터·페이징 구조는 `crawler_sources.detail_selector` JSONB에 저장.

## 5. 기술 선택

### 5.1 fetch 라이브러리

- **1순위**: 표준 `fetch` + **cheerio** — 정적 HTML 사이트
- **2순위 검토**: JavaScript 렌더링 필요 사이트
  - `@sparticuz/chromium` + Playwright on Vercel (까다로움)
  - **외부 스크래핑 SaaS** (ScrapingBee, Bright Data) — 권장
  - Vercel cron 함수 외부에서 별도 워커 (Railway 등) — 최후

### 5.2 분류 모델

- 기본: **Claude Sonnet 4.6** (어드바이저와 동일 모델 → 모델 캐시·키 일원화)
- 비용 절감 옵션: **Claude Haiku 4.5** ($1/$5 vs Sonnet $3/$15) — 분류 정확도 평가 후 결정

### 5.3 분류 프롬프트 (초안)

```
다음은 정부·공공기관 공고입니다.

[공고 제목]
{title}

[공고 본문]
{content}

다음을 판별하세요:
1. is_ict_fund: ICT기금 비R&D 공모사업인가? (true/false)
2. category: 다음 중 가장 적합한 카테고리 (해당 없으면 "기타")
   - "비R&D-스타트업지원"
   - "비R&D-인력양성"
   - "비R&D-인프라"
   - "비R&D-국제협력"
   - "R&D" (해당 시 is_ict_fund=false)
   - "타분야"
   - "기타"
3. extracted: 핵심 정보 JSON
   {
     "target": "지원대상 (예: 중소·벤처기업)",
     "support_type": "지원방식 (자금/멘토링/공간 등)",
     "fund_amount": "지원금액 (텍스트)",
     "application_period": "접수기간",
     "agency": "주관기관"
   }

JSON 으로만 응답하세요.
```

→ `output_config.format` 또는 `tool_use`로 구조화 출력 강제.

## 6. Vercel Cron 설정

```jsonc
// vercel.json
{
  "crons": [
    { "path": "/api/cron/crawl-announcements", "schedule": "0 */6 * * *" },
    { "path": "/api/cron/refresh-law-cache",   "schedule": "0 3 * * *" }
  ]
}
```

- Pro 플랜 기준 분 단위 가능
- maxDuration 300s (Fluid Compute) 내 처리
- 사이트 N개 × 신규 공고 평균 K건 × 분류 1초 ≈ 한 번에 처리 가능한 양 사전 측정 필요
- 부족하면 **사이트별 분할** (Cron 매 시간 다른 소스 처리)

## 7. 사용자 인터페이스

### `(admin)/announcements/page.tsx`

- 신규 공고 리스트 (게시일·마감 기준 정렬)
- 필터: 기관, 카테고리, 마감 임박, ICT기금 여부
- 검색: 키워드 + 시맨틱(임베딩) hybrid

### 일반 사용자용 (옵션)

- ICT기금 비R&D 공고만 필터링한 공개 페이지
- RSS·Webhook으로 외부 시스템 연동 검토

## 8. 보안·운영

- **robots.txt 준수** — 크롤링 전 확인, 거부 사이트 제외
- **rate limit** — 사이트당 동시 요청 1개, 요청 간 최소 1초 간격
- **User-Agent 명시** — `PIMS-Crawler/1.0 (+contact-email)` 로 식별 가능하게
- **저작권** — 원문 전체 저장은 내부 분석 용도로 제한, 사용자 노출은 제목·요약·원본 링크 위주
- **장애 격리** — 1개 사이트 실패 시 나머지 진행, `crawl_runs.status='partial'`

## 9. 평가 지표

| 지표 | 목표 |
|---|---|
| 일일 신규 공고 수집률 | ≥ 95% (수동 확인 대비) |
| ICT기금 비R&D 분류 정확도 | ≥ 0.90 |
| 평균 크롤링 1회 소요 시간 | ≤ 5분 |
| 누락 사고 0건 (마감 7일 전 공고) | 100% |
