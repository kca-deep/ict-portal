# 8회차 - 공모사업 웹크롤링 기반: 스펙(SourceSpec) 정의 → 범용 엔진 → 1개 사이트 파일럿

> 이 문서는 `docs/05-feature-crawler.md`(② 공모사업 크롤러 설계안)의 **1차 구현 계획 — "웹크롤링 기반" 회차**다.
> 원래 8월 예정 기능(M6)의 **기반(스키마·스펙·엔진)만 선행 착수**한다. AI 분류·임베딩 색인·Cron 자동 실행·admin 탭은 이번 회차에 만들지 않는다(후속 회차).
> 기존 챗봇·관리자 화면(`app/page.tsx`·`components/**`·`app/admin/**`)은 **일절 건드리지 않는다.** 새로 만드는 것은 전부 `supabase/migrations/`·`lib/crawler/`·`scripts/`.

> **⚠️ 이번 회차의 핵심 설계 요구 (사용자 확정)**
> 크롤링 대상 웹페이지는 **사이트마다 화면 구조가 전부 다르다.** 사이트마다 크롤러 코드를 따로 짜면 사이트 수만큼 코드가 늘고 유지보수가 불가능해진다. 그래서 **"어디서 무엇을 뽑을지"를 코드가 아니라 데이터(스펙 JSONB)로 정의**하고, **엔진은 스펙을 읽어 실행하는 범용 해석기 하나**만 둔다. → **새 사이트 추가 = 코드 무변경, 스펙 한 건 등록.**

| 항목 | 내용 |
|------|------|
| 날짜 | 2026-07-14 주 (이번 주) |
| 이번 주제 | **웹크롤링 기반** — ① DB 스키마 3종 ② 통합 크롤링 스펙(SourceSpec) 정의 ③ 공통 수집 계층(예절·안전) ④ 스펙 해석 엔진 ⑤ 1개 사이트 파일럿 |
| 선행 상태 | 없음 (크롤러 관련 코드·테이블·cron 전무 — 이번이 첫 회차) |
| 손대지 않는 것 | `app/page.tsx`, `components/**`, `app/admin/**`, `app/api/chat/**` (기존 화면·챗 파이프라인 전부) |
| 새로 만드는 것 | `supabase/migrations/`(크롤러 3테이블), `lib/crawler/**`(스펙·수집·엔진), `scripts/crawl.ts`(수동 실행) |
| 이번에 안 만드는 것 | AI 분류(Claude), 임베딩 색인, Vercel Cron, admin 크롤러 탭, 다중 사이트 확장, JS 렌더링 사이트 대응 |

> **이번 회차 한 줄 요약**
> 크롤러는 **그릇(테이블) → 규격(스펙) → 기계(엔진) → 시운전(1개 사이트)** 순으로 만든다. 사이트별 차이는 전부 **스펙 한 장**에 가두고, 엔진은 스펙만 읽는 **범용 해석기**로 만들어, 이후 사이트가 7개로 늘어도 코드는 그대로인 구조를 이번에 완성한다.

---

## 0. 왜 이 순서인가 (가장 먼저 볼 것)

| 이유 | 내용 |
|---|---|
| **스키마 먼저·단독으로** | DB 스키마 변경은 프로젝트 원칙상 **단독 커밋/PR**(기능 코드와 안 묶음). 그릇이 먼저 있어야 스펙·엔진이 저장할 곳이 생긴다. |
| **스펙이 엔진보다 먼저** | 엔진은 "스펙을 실행하는 기계"다. 규격(무엇을 어떻게 표현하나)이 정해져야 기계를 설계할 수 있다. 반대로 하면 엔진 형편에 스펙이 끌려가 사이트 하나에 과적합된다. |
| **공통 수집 계층을 엔진과 분리** | robots.txt·속도 제한·신원 명시·타임아웃·인코딩은 **어느 사이트든 똑같이** 지켜야 하는 예절/안전이다. 스펙 해석(사이트별 차이)과 섞이면 안 된다. |
| **파일럿은 1개 사이트만** | 스펙 규격이 실제 사이트 하나를 통과해야 "통합 스펙"이 검증된다. 2번째 사이트부터는 **코드 무변경으로 스펙만 추가**되는지가 다음 회차의 검증 항목이다. |
| **AI 분류·임베딩은 뒤로** | 수집이 안 되면 분류할 것도 없다. 이번 회차는 "원문이 안전하게·중복 없이 쌓인다"까지만. 돈 드는 단계(LLM·임베딩)는 수집이 검증된 뒤 붙인다. |

> **⚠️ 스펙을 만능으로 만들지 말 것 (PoC / YAGNI).** 스펙은 **정적 HTML + CSS 셀렉터 + 단순 페이지네이션**까지만 표현한다. JS 렌더링·로그인·무한스크롤 대응 필드를 미리 설계하지 않는다. 그런 사이트는 `render` 필드에 표시만 해 두고 **이번엔 수집 대상에서 제외**한다(`docs/05` §5.1의 2순위 검토 사항).

---

## 1. 이번 주 순서 (한눈에)

| 번호 | 무엇을 | 왜 이 순서인가 | 커밋 |
|---|---|---|---|
| **1** | DB 마이그레이션 — `crawler_sources`·`announcements`·`crawl_runs` | 그릇 먼저. **스키마 단독 커밋** 원칙 | 단독 |
| **2** | 통합 크롤링 스펙(SourceSpec) 정의 — zod 스키마 + 규격 문서 | 규격이 기계보다 먼저 | 기능 |
| **3** | 공통 수집 계층 — robots.txt·속도 제한·UA·타임아웃·인코딩 | 어느 사이트든 같은 예절/안전 | 기능 |
| **4** | 스펙 해석 엔진 — 목록 → 신규 판별 → 상세 → UPSERT → 실행 기록 | 규격을 실행하는 범용 기계 | 기능 |
| **5** | 1개 사이트 파일럿 — 스펙 작성·등록 + 수동 실행 + 검증 | 규격·기계의 시운전 | 기능 |

> 1번 = **그릇**, 2번 = **규격**, 3·4번 = **기계**, 5번 = **시운전**. 기존 화면·챗 파이프라인은 처음부터 끝까지 무변경.

---

## 2. [1번] DB 마이그레이션 — 크롤러 3테이블

### 2-1. 무엇을·왜

`docs/03-data-model.md` §4의 크롤러 테이블 3종을 마이그레이션으로 만든다. 단, 사용자 확정 요구(통합 스펙)에 맞춰 **한 가지를 바꾼다**: `docs/03`은 추출 규칙을 `list_selector text` + `detail_selector jsonb` 두 컬럼으로 나눠 뒀는데, 목록·상세·페이지네이션·수집 옵션이 **한 몸의 규격**이므로 **`spec jsonb` 단일 컬럼으로 통합**한다. (반영 후 `docs/03`도 갱신 — 설계 결정 변경 시 docs 갱신 원칙.)

### 2-2. 테이블 요약

| 테이블 | 담는 것 | 핵심 |
|---|---|---|
| `crawler_sources` | 수집 대상 사이트 + **통합 스펙(`spec jsonb`)** | `enabled`, `last_crawled_at`, `crawl_interval` |
| `announcements` | 수집한 공고 한 건 한 건 | **`unique (source_id, external_id)`** — 같은 공고 중복 저장 방지(UPSERT 기준). `embedding vector(1024)`·`fts`는 컬럼만 만들고 **이번엔 비워 둠**(색인은 후속 회차) |
| `crawl_runs` | 실행 1회당 결과 이력 | `status: running/success/partial/failed`, 발견·신규·갱신 건수, 오류 메시지 |

공통 원칙(`docs/03` §2) 그대로: `id bigint identity PK`, `created_at`/`updated_at`, `metadata jsonb`, **전 테이블 RLS enable + service_role 외 접근 차단**(크롤러 테이블은 외부 노출 없음 — anon 정책 없음).

### 2-3. 해법

| 단계 | 작업 | 위치 |
|---|---|---|
| 1 | 3테이블 + 인덱스(hnsw(embedding)·gin(fts)·btree(deadline) partial) + RLS 마이그레이션 작성 | `supabase/migrations/2026MMDD000001_crawler_tables.sql`(신규) |
| 2 | `pnpm db:push`로 적용 확인 | (로컬/Supabase) |
| 3 | **이 마이그레이션만 단독 커밋** | (git) |

### ▶ 사용자 프롬프트 — 1번

> 공모사업 크롤러의 그릇부터 만들자. `docs/03-data-model.md` §4의 `crawler_sources`·`announcements`·`crawl_runs` 세 테이블을 **새 마이그레이션 파일 하나**로 만들어 줘(기존 마이그레이션 수정 금지). 단 한 가지 바꿀 게 있어 — 사이트마다 화면 구조가 달라서 추출 규칙을 통합 관리해야 하니, `crawler_sources`의 `list_selector`·`detail_selector` 두 컬럼 대신 **`spec jsonb not null` 단일 컬럼**으로 통합해 줘. `announcements`에는 `unique (source_id, external_id)` 중복 방지 제약과 `embedding vector(1024)`·`fts` 컬럼을 넣되 색인 데이터는 아직 안 채울 거야. 세 테이블 모두 RLS를 켜고 service_role 외에는 접근 못 하게 해(외부 노출 없음). `pnpm db:push`로 적용 확인하고, **이 마이그레이션만 단독으로 커밋**해 줘 — 스키마 변경은 기능 코드와 안 묶는 게 우리 원칙이야. `docs/03`의 해당 표 설명도 spec 통합에 맞게 갱신해 줘.

---

## 3. [2번] 통합 크롤링 스펙(SourceSpec) 정의 — 이번 회차의 심장

### 3-1. 무엇을·왜

**사이트마다 다른 것**(어느 주소, 어떤 셀렉터, 어떤 페이지 넘김, 어떤 날짜 표기, 어떤 인코딩)을 전부 **스펙 한 장**에 선언한다. 엔진은 이 스펙만 읽는다. 스펙은 `crawler_sources.spec`(JSONB)에 저장되고, 코드에서는 **zod 스키마로 검증**해서 잘못된 스펙이 조용히 오작동하는 것을 막는다(`lib/env.ts`의 부팅 가드와 같은 패턴 — 데이터도 검증하고 쓴다).

### 3-2. SourceSpec 규격 (v1 — 정적 HTML 전용)

```jsonc
{
  "fetch": {
    "charset": "utf-8",          // 정부 사이트 대비: "euc-kr" 지원 (iconv 디코딩)
    "render": "static",           // v1은 "static"만 유효. JS 렌더링 사이트는 등록만 하고 enabled=false
    "timeoutMs": 10000,           // docs/05 §3: 타임아웃 10초
    "delayMs": 1000               // docs/05 §8: 요청 간 최소 1초
  },
  "list": {
    "url": "https://.../bbs/list.do?mId=113",
    "pagination": {               // 페이지 넘김 방식 3종만
      "type": "query",            // "query"(?pageIndex=N) | "path"(/list/N) | "none"(1페이지만)
      "param": "pageIndex",
      "start": 1,
      "maxPages": 3               // 신규 공고는 앞 페이지에 몰림 — 전체 순회 안 함
    },
    "row": "table.board_list tbody tr",   // 공고 1건 = 행 1개
    "fields": {                   // 행 안에서 무엇을 뽑나 (필수: external_id, title, detail_url)
      "external_id": { "selector": "td.num",     "attr": "text" },
      "title":       { "selector": "td.title a", "attr": "text" },
      "detail_url":  { "selector": "td.title a", "attr": "href", "resolve": "absolute" },
      "posted_at":   { "selector": "td.date",    "attr": "text", "dateFormat": "YYYY.MM.DD" }
    }
  },
  "detail": {
    "content":  { "selector": "div.view_cont", "strip": ["script", "style", "img"] },
    "deadline": { "selector": "ul.info li.due", "dateFormat": "YYYY-MM-DD", "optional": true }
  }
}
```

**필드 추출 규칙(FieldRule)의 공통 문법** — 모든 필드가 같은 형태를 쓴다:

| 키 | 뜻 | 비고 |
|---|---|---|
| `selector` | CSS 셀렉터 (cheerio) | 필수 |
| `attr` | `"text"`(글자) 또는 속성명(`"href"` 등) | 기본 `"text"` |
| `resolve` | `"absolute"`면 상대 URL을 절대 URL로 변환 | 링크용 |
| `dateFormat` | 날짜 문자열 해석 형식 (`YYYY.MM.DD` 등) | 사이트마다 표기가 달라서 스펙에 둠 |
| `optional` | 없어도 오류 아님 | 기본 false — 필수 필드 누락은 그 행 skip + 기록 |

### 3-3. 스펙 설계 3원칙

| 원칙 | 내용 |
|---|---|
| **차이는 스펙에, 공통은 엔진에** | 셀렉터·페이지네이션·날짜형식·인코딩 = 스펙. robots·속도제한·UPSERT·오류격리 = 엔진. 이 경계를 흐리지 않는다. |
| **v1은 좁게** | 정적 HTML + CSS 셀렉터 + 3종 페이지네이션까지만. 표현 못 하는 사이트는 스펙을 늘리지 말고 **제외 목록으로 기록**(후속 판단 재료). |
| **스펙은 검증하고 쓴다** | DB에서 읽은 JSONB를 zod `SourceSpecSchema.parse()` 통과 후에만 엔진에 투입. 실패 시 그 소스만 `failed` 처리(다른 소스 계속). |

### 3-4. 해법

| 단계 | 작업 | 위치 |
|---|---|---|
| 1 | `SourceSpecSchema`(zod) + `SourceSpec` 타입 + FieldRule 공통 문법 | `lib/crawler/spec.ts`(신규) |
| 2 | 규격 문서화(위 예시 + 필드 표) — 스펙 작성자용 | `docs/05-feature-crawler.md` §4에 추가 |

### ▶ 사용자 프롬프트 — 2번

> 이제 이번 회차의 핵심인 **통합 크롤링 스펙**을 정의하자. 크롤링 대상 사이트마다 화면 구조가 전부 달라서, 사이트별 차이(목록 주소·행 셀렉터·필드 추출 규칙·페이지 넘김·날짜 표기·문자 인코딩)를 **코드가 아니라 JSONB 스펙 한 장**으로 선언하고, 엔진은 스펙만 읽게 할 거야. `lib/crawler/spec.ts`에 **zod 스키마(`SourceSpecSchema`)와 TypeScript 타입**을 만들어 줘. 구조는 `fetch`(charset·render·timeoutMs·delayMs) / `list`(url·pagination·row·fields) / `detail`(필드별 추출 규칙) 세 부분이고, 모든 필드 추출은 `{selector, attr, resolve?, dateFormat?, optional?}` 공통 문법 하나로 통일해. 페이지네이션은 query·path·none 세 가지만, `render`는 `"static"`만 유효하게 해(JS 렌더링은 이번 범위 밖 — 값은 받아 두되 static이 아니면 검증 단계에서 거부). 필수 목록 필드는 external_id·title·detail_url이야. DB에서 읽은 스펙은 반드시 이 스키마로 parse해서 통과한 것만 쓰게 할 거야. 규격 설명(예시 JSON + 필드 표)을 `docs/05` §4에도 추가해 줘.

---

## 4. [3번] 공통 수집 계층 — 예절·안전 (사이트 무관)

### 4-1. 무엇을·왜

`docs/05` §8 보안·운영 수칙은 **어느 사이트를 긁든 똑같이** 지켜야 한다. 스펙 해석(사이트별)과 분리된 **공통 수집 함수 하나**로 만들어, 엔진의 모든 HTTP 요청이 이 관문을 지나게 한다.

| 수칙 | 구현 |
|---|---|
| robots.txt 준수 | 수집 전 해당 경로 허용 여부 확인, 거부 시 그 소스 skip + 기록 |
| 속도 제한 | 사이트당 동시 요청 1개, 요청 간 `delayMs`(기본 1초) 대기 |
| 신원 명시 | `User-Agent: PIMS-Crawler/1.0 (+연락처)` |
| 타임아웃 | `timeoutMs`(기본 10초) 초과 시 실패 처리 — 전체는 계속 |
| 인코딩 | `charset`이 euc-kr이면 디코딩 후 cheerio에 전달 |

### 4-2. 해법

| 단계 | 작업 | 위치 |
|---|---|---|
| 1 | `fetchPage(url, fetchOpts)` — UA·타임아웃·인코딩·지연 일괄 처리 | `lib/crawler/fetch.ts`(신규) |
| 2 | `isAllowedByRobots(url)` — robots.txt 조회·판정(소스당 1회 캐시) | `lib/crawler/fetch.ts` |

### ▶ 사용자 프롬프트 — 3번

> 스펙 해석과 분리된 **공통 수집 계층**을 만들자. `lib/crawler/fetch.ts`에 모든 크롤링 HTTP 요청이 거쳐 가는 `fetchPage` 함수를 만들어 줘: ① `User-Agent: PIMS-Crawler/1.0 (+연락처)` 신원 명시 ② 타임아웃(스펙의 timeoutMs, 기본 10초) ③ 요청 사이 최소 지연(스펙의 delayMs, 기본 1초 — 같은 사이트에 동시 요청 금지) ④ euc-kr 같은 비UTF-8 인코딩 디코딩. 그리고 수집 전에 그 사이트의 **robots.txt를 확인해 거부된 경로면 수집하지 않는** `isAllowedByRobots` 함수도 넣어 줘(소스당 한 번만 조회해 캐시). 이건 사이트가 몇 개로 늘든 똑같이 지켜야 하는 예절이라 스펙이 아니라 공통 코드에 두는 거야.

---

## 5. [4번] 스펙 해석 엔진 — 범용 크롤 기계

### 5-1. 무엇을·왜

스펙(2번)을 입력으로 받아 `docs/05` §3의 처리 흐름 중 **수집 구간(1~4·8·9단계)** 을 실행하는 범용 엔진. **사이트 이름이 코드에 등장하면 설계 실패**다 — 엔진은 스펙만 안다.

```
crawler_sources(enabled=true) → 소스별로:
  crawl_runs에 'running' 기록
  → robots 확인 → 목록 페이지 fetch(페이지네이션 순회, maxPages까지)
  → row 셀렉터로 행 추출 → FieldRule로 external_id·title·detail_url·posted_at 추출
  → 기존 announcements의 external_id와 대조해 신규만 선별
  → 신규 건마다 상세 fetch → detail 규칙으로 본문·마감일 추출
  → announcements UPSERT (unique(source_id, external_id) 기준)
  → crawl_runs 갱신: success/partial/failed + 발견·신규·갱신 건수
```

**장애 격리 2단**: ① 행 하나가 이상해도(필수 필드 누락) 그 행만 skip하고 계속 → `partial` ② 소스 하나가 통째로 실패해도(접속 불가·스펙 검증 실패) 다음 소스 계속 → 해당 run만 `failed`.

### 5-2. 해법

| 단계 | 작업 | 위치 |
|---|---|---|
| 1 | `parseList(html, spec)` / `parseDetail(html, spec)` — cheerio + FieldRule 해석(순수 함수) | `lib/crawler/parse.ts`(신규) |
| 2 | `crawlSource(source)` — 위 흐름 1개 소스 실행 (service_role로 DB 접근) | `lib/crawler/engine.ts`(신규) |
| 3 | `crawlAll()` — enabled 소스 순회 + 소스 간 장애 격리 | `lib/crawler/engine.ts` |

### ▶ 사용자 프롬프트 — 4번

> 이제 스펙을 실행하는 **범용 엔진**을 만들자. `lib/crawler/parse.ts`에 HTML과 스펙을 받아 목록 행들·상세 본문을 뽑는 **순수 파서 함수**(`parseList`·`parseDetail`, cheerio 사용)를 만들고, `lib/crawler/engine.ts`에 소스 1개를 처리하는 `crawlSource`와 enabled 소스 전체를 도는 `crawlAll`을 만들어 줘. 흐름은: crawl_runs에 running 기록 → robots 확인 → 목록 페이지를 페이지네이션 스펙대로 maxPages까지 fetch → 행 추출 → **이미 announcements에 있는 external_id는 건너뛰고 신규만** 상세 fetch → 본문 추출 → `unique(source_id, external_id)` 기준 UPSERT → crawl_runs에 success/partial/failed와 발견·신규·갱신 건수 기록. 장애 격리는 2단으로: 행 하나가 필수 필드 누락이면 **그 행만 건너뛰고** partial로, 소스 하나가 통째로 실패하면 **그 run만 failed로 남기고 다음 소스 계속**. DB 접근은 서버 전용 service_role 클라이언트로만 해. 그리고 중요한 것 — **엔진 코드에 특정 사이트 이름·주소·셀렉터가 하드코딩되면 안 돼.** 사이트별 차이는 전부 스펙에서 와야 해. AI 분류와 임베딩은 이번에 안 붙여(다음 회차).

---

## 6. [5번] 1개 사이트 파일럿 — 시운전

### 6-1. 무엇을·왜

규격(스펙)과 기계(엔진)가 **실제 사이트 하나**를 통과해야 기반이 검증된다. `docs/05` §4의 1차 후보 중 **정적 HTML로 목록·상세가 열리는 사이트 1곳**을 회차 중 실사(브라우저 개발자도구로 확인)해서 고른다 — 후보 우선순위: 전담기관인 **NIPA(nipa.kr)** → IITP → 과기정통부. 실행은 Cron이 아니라 **수동 스크립트**로 한다(자동 실행은 파이프라인 완성 후 — 반쪽 데이터가 자동으로 쌓이는 것 방지).

### 6-2. 해법

| 단계 | 작업 | 위치 |
|---|---|---|
| 1 | 대상 사이트 실사 → 목록·상세 셀렉터 확인 → 스펙 JSON 작성 | (브라우저 개발자도구) |
| 2 | 스펙을 `crawler_sources`에 등록하는 시드 스크립트 | `scripts/seed-crawler-source.ts`(신규) |
| 3 | `crawlAll()` 수동 실행 스크립트 | `scripts/crawl.ts`(신규) |
| 4 | 결과 검증(아래 6-3) + 2회 연속 실행으로 중복 방지 확인 | (Supabase 콘솔/SQL) |

### 6-3. ✅ 파일럿 검증

- 첫 실행: `announcements`에 **실제 공고 행들이 쌓임** (제목·게시일·원본 URL·본문이 채워짐)
- **같은 명령 한 번 더 실행 → 신규 0건, 행 수 그대로** (UPSERT 중복 방지 동작)
- `crawl_runs`에 두 번의 실행이 각각 기록됨 (건수·상태 포함)
- 스펙의 셀렉터를 일부러 틀리게 바꿔 실행 → 그 소스만 `failed`, 프로세스는 정상 종료 (장애 격리)
- 요청 로그에 `PIMS-Crawler/1.0` UA와 요청 간 1초 이상 간격이 보임 (예절 확인)

### ▶ 사용자 프롬프트 — 5번

> 시운전하자. 먼저 NIPA(nipa.kr) 공고 게시판이 정적 HTML로 열리는지 확인하고(안 되면 IITP → 과기정통부 순으로), 목록 행·제목·링크·게시일·상세 본문의 CSS 셀렉터를 파악해서 우리 SourceSpec 규격대로 **스펙 JSON을 작성**해 줘. 그 스펙을 `crawler_sources`에 넣는 시드 스크립트(`scripts/seed-crawler-source.ts`)와, 엔진을 수동으로 돌리는 실행 스크립트(`scripts/crawl.ts`)를 만들어 줘 — Cron 자동 실행은 아직 안 붙여. 실행 후 네 가지를 확인해 줘: ① `announcements`에 실제 공고가 제목·날짜·URL·본문까지 채워져 쌓이는지 ② **한 번 더 돌렸을 때 신규 0건으로 중복이 안 쌓이는지** ③ `crawl_runs`에 실행 이력·건수가 남는지 ④ 셀렉터를 일부러 틀리게 하면 그 소스만 failed로 남고 죽지 않는지. 마지막에 `pnpm build` 통과도 확인해 줘.

---

## 7. 구현계획 (단계별) + 파일 맵

작은 것·위험 낮은 것부터. **각 단계 끝에 `pnpm build` 확인.** 1번(스키마)은 **반드시 단독 커밋**.

| 번호 | 작업 | 손대는 파일 | 커밋 |
|---|---|---|---|
| **1** | 크롤러 3테이블 마이그레이션 (`spec jsonb` 통합) + docs/03 갱신 | `supabase/migrations/*_crawler_tables.sql`(신규), `docs/03` | **단독** |
| **2** | SourceSpec zod 스키마 + 규격 문서 | `lib/crawler/spec.ts`(신규), `docs/05` | 기능 |
| **3** | 공통 수집 계층 (robots·UA·지연·타임아웃·인코딩) | `lib/crawler/fetch.ts`(신규) | 기능 |
| **4** | 스펙 해석 엔진 (파서 + crawlSource/crawlAll) | `lib/crawler/parse.ts`·`engine.ts`(신규) | 기능 |
| **5** | 파일럿 (스펙 작성·시드·수동 실행·검증) | `scripts/seed-crawler-source.ts`·`crawl.ts`(신규) | 기능 |

```
supabase/migrations/
└─ *_crawler_tables.sql ····· [1] (신규) crawler_sources(spec jsonb)·announcements·crawl_runs + RLS
lib/crawler/                   (신규 모듈 — CLAUDE.md 모듈 경계표의 ② 담당)
├─ spec.ts ·················· [2] SourceSpecSchema(zod) + 타입 — 통합 스펙 규격의 진실원
├─ fetch.ts ················· [3] fetchPage · isAllowedByRobots (예절·안전 공통 관문)
├─ parse.ts ················· [4] parseList · parseDetail (스펙 해석 순수 파서)
└─ engine.ts ················ [4] crawlSource · crawlAll (수집 흐름 + 장애 격리)
scripts/
├─ seed-crawler-source.ts ··· [5] 파일럿 스펙 등록
└─ crawl.ts ················· [5] 수동 실행 (Cron은 후속 회차)
docs/03·05 ·················· [1·2] spec 통합·규격 반영
app/** · components/** ······· 변경 없음 (기존 화면·챗 파이프라인 무변경)
```

> **순서가 핵심**: 그릇(1, 단독 커밋) → 규격(2) → 기계(3·4) → 시운전(5). "새 사이트 추가 = 스펙 한 건"이 되는 구조를 이번에 굳힌다.

---

## 8. 핵심 용어 (한 줄 정의)

| 용어 | 한 줄 설명 |
|---|---|
| **SourceSpec(통합 크롤링 스펙)** | 사이트별 차이(주소·셀렉터·페이지 넘김·날짜형식·인코딩)를 선언한 JSONB 규격. `crawler_sources.spec`에 저장. |
| **FieldRule** | 필드 하나를 뽑는 공통 문법 `{selector, attr, resolve?, dateFormat?, optional?}`. 목록·상세 모두 이 문법 하나로 통일. |
| **스펙 해석 엔진** | 스펙을 읽어 수집을 실행하는 범용 기계. 사이트 이름이 코드에 나오면 설계 실패. |
| **cheerio** | 서버에서 HTML을 jQuery처럼 CSS 셀렉터로 뒤지게 해 주는 라이브러리(브라우저 없이 동작 — 정적 HTML 전용). |
| **UPSERT (중복 방지)** | `unique(source_id, external_id)`에 걸리면 INSERT 대신 갱신. 같은 공고가 다시 와도 안 쌓임. |
| **장애 격리** | 행 하나 실패 → 그 행만 skip(`partial`) / 소스 하나 실패 → 그 run만 `failed`, 나머지 계속. |
| **robots.txt** | 사이트가 크롤러에게 알리는 수집 허용/거부 규칙. 수집 전 확인, 거부 시 제외. |
| **파일럿** | 실제 사이트 1곳으로 규격·기계를 시운전하는 것. 2호 사이트부터 "코드 무변경"이 진짜 검증. |

---

## 9. 직접 만져보며 복습하기 (회차 후)

1. `crawler_sources`의 `spec`을 콘솔에서 열어 보고, **fetch / list / detail** 세 부분이 각각 무엇을 선언하는지 설명해 보기.
2. 파일럿 사이트의 공고 목록을 브라우저에서 열고, 개발자도구로 **스펙의 `row`·`fields` 셀렉터가 실제 어느 요소를 가리키는지** 눈으로 대조하기.
3. `scripts/crawl.ts`를 **연속 2회 실행** → 2회차에 신규 0건인지, `crawl_runs`에 두 줄이 남는지 확인(중복 방지·이력).
4. 스펙의 `dateFormat`을 틀리게 바꿔 실행 → 어떤 단위로 실패하는지(행 skip? 소스 failed?) 관찰하고 되돌리기.
5. 스펙 JSON에서 필수 필드(`title`)를 지우고 실행 → **zod 검증이 소스 투입 전에 거부**하는지 확인.
6. `announcements`에서 `select source_id, external_id, count(*) group by 1,2 having count(*) > 1` → 0건(유니크 제약 동작).

---

> 이 회차를 마치면 **크롤러의 기반**이 선다 — 사이트별 구조 차이는 전부 **스펙 한 장(JSONB)** 에 갇히고, **범용 엔진 하나**가 그것을 실행하며, 실제 사이트 1곳의 공고가 **중복 없이·예절 바르게** 쌓인다.
>
> **남은 후속 (다음 회차들)**: ① **AI 분류** — Claude로 ICT기금 비R&D 여부·카테고리 판별(`docs/05` §5.2~5.3), 구조화 출력. ② **임베딩 색인** — 공고 본문 OpenAI 임베딩 + fts 채우기, 검색 연결. ③ **Vercel Cron 자동 실행**(`0 */6 * * *`) + 실행 시간 측정·분할. ④ **다중 사이트 확장** — 2호 사이트부터 "코드 무변경, 스펙만 추가" 검증. ⑤ **admin 크롤러 탭** — 공고 열람·소스 관리·실행 이력(`docs/05` §7).
