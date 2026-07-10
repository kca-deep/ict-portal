# 관리자 콘솔 — 피드백 노출 + 검색·정렬·날짜범위

- 날짜: 2026-07-10
- 상태: 설계 승인 → 구현
- 범위: 이미 수집 중인 `feedback`/`feedback_note` 를 관리자 콘솔에 노출하고, 로그 표에 자유 검색·열헤더 정렬·커스텀 날짜범위를 추가한다.
- 범위 밖(YAGNI): CSV 익스포트, 기관별 집계(로그인 미도입), 실시간 새로고침, 로그인 하드닝(별도 과제).

## 배경

직전 과제(2026-07-10 `query_log 세션·피드백`)가 `/api/feedback` 로 `feedback`(+1/0/−1)·`feedback_note` 를 `query_log` 에 **적재하는 배선만** 했고, 관리자 콘솔(`app/admin/`) 어디에도 노출이 없다.

- `LIST_COLUMNS`(query-log.ts)에 `feedback` 없음 → 표에 안 뜸.
- `QueryLogDetail` 타입에 `feedback`/`feedback_note` 없음 → 상세 패널에 안 뜸.
- `queryLogStats` 는 피드백을 집계하지 않음 → 만족도 KPI 없음.

또한 로그 표 필터는 분기·환각·IP·기간(24h/7d/전체) 프리셋뿐이라 **질문 키워드 검색·임의 정렬·임의 날짜구간**이 불가하다.

## 결정

- **만족도 정의**: rated = `feedback ∈ {−1, +1}` (0/NULL 제외). `satisfactionPct = positive / rated`. rated=0 이면 `–`.
- **👎만 필터**: `feedback = -1` 인 행만. 필터바에서 `환각만` 옆 토글(`negativeOnly`).
- **검색 범위**: 질문+답변(`query`·`answer` ilike). PoC 규모(≤5000행)라 인덱스 없이 `ilike` 로 충분.
- **정렬**: 열헤더 클릭 → `sort`/`dir` URL 파라미터. **허용 컬럼 화이트리스트**로 제한(임의 컬럼 정렬 차단): `created_at`·`top_score`·`total_ms`·`tokens`·`feedback`. 기본 `created_at desc`.
  - `tokens` 는 실제 컬럼이 아니라 `tokens_in + tokens_out` → 정렬은 `tokens_in` 기준으로 근사(합계 정렬용 생성컬럼 없음, 스키마 변경 회피).
- **날짜 커스텀**: 기존 프리셋 유지 + `from`/`to`(`type="date"`) 입력 추가. 값이 있으면 `since`/`until` 을 덮어씀(프리셋보다 우선).
- **필터 UI 철학 유지**: 현재 필터는 클라JS 없는 `<Link>` 칩. 검색·날짜는 **서버 렌더 `<form method="get" action="/admin">`** + 기존 파라미터 hidden input 으로 보존 → 클라JS 불필요.
- **잠재버그 동시수정**: `LogTable` 은 `useState(initialRows)` 라 URL만 바뀌면 초기행이 갱신 안 됨(스테일). 필터 파라미터 해시를 `key` 로 줘 remount 강제.

## 설계

세 조회 함수(`listQueryLogs`·`queryLogStats`·`/api/admin/logs`)에 **동일 필터**를 태워 표·통계·"더보기"가 항상 같은 모집단을 본다.

### A. 데이터 계층 — `lib/db/query-log.ts`

1. `QueryLogFilter` 필드 추가:
   ```ts
   search?: string;                 // query|answer ilike
   until?: string;                  // created_at <= until (ISO)
   sort?: "created_at" | "top_score" | "total_ms" | "tokens" | "feedback";
   sortDir?: "asc" | "desc";
   negativeOnly?: boolean;          // feedback = -1
   ```
2. 공통 필터 적용 헬퍼로 3함수 중복 제거(`applyFilter(q, filter)`) — `route`/`hallucinationOnly`/`ip`/`since`/`until`/`search`/`negativeOnly` 를 한 곳에서 건다. `search` 는 `q.or("query.ilike.%kw%,answer.ilike.%kw%")`(kw 는 `%`/`,` 등 PostgREST 특수문자 이스케이프 후 삽입).
3. 정렬: 화이트리스트에서만 컬럼 선택. `tokens` → `tokens_in`. `listQueryLogs` 의 `.order(...)` 를 `sort`/`sortDir` 기반으로.
4. `LIST_COLUMNS` 에 `feedback` 추가. `QueryLogListItem` 에 `feedback: number | null` 추가.
5. `QueryLogDetail` 에 `feedback: number | null`, `feedback_note: string | null` 추가(조회는 이미 `select("*")` 라 컬럼만 타입에 노출).
6. `QueryLogStats` 에 `positiveCount`·`ratedCount`·`satisfactionPct: number | null` 추가. `queryLogStats` select 에 `feedback` 추가하고 루프에서 집계. `search`/`until`/`negativeOnly` 도 `applyFilter` 로 동일 적용.

### B. 품질 스트립 — `app/admin/page.tsx`

- `grid-cols-2 ... sm:grid-cols-4` → `sm:grid-cols-5`.
- 5번째 `Kpi` 추가(신규 컴포넌트 없이 기존 미터 패턴 재사용):
  ```
  만족도  👍{satisfactionPct}%   미터=satisfactionPct(primary)   note=`{positive}/{rated}`
  ```
  rated=0 → value `–`, meter 0.

### C. 필터 바 — `app/admin/page.tsx`

- 검색 폼(서버 렌더 GET): text input `name="q"` + 조회 버튼. 기존 파라미터(period/route/halluc/ip/from/to/sort/dir)를 hidden input 으로 보존. 제출 시 `log` 파라미터는 제외(상세 닫힘).
- 커스텀 날짜: 같은/별도 GET 폼에 `type="date"` 2칸(`name="from"`,`name="to"`) + 적용 버튼. `from`→`since`, `to`→`until`(23:59:59 로 보정해 그날 포함). 값 있으면 프리셋보다 우선.
- `👎만` 칩: `환각만` 옆, 동일 `<Link>` 토글. 활성 시 파랑 계열(destructive 아님 — 환각과 구분).
- `href()` 헬퍼 병합 키에 `q`/`from`/`to`/`sort`/`dir`/`neg` 추가.

### D. 로그 표 — `app/admin/log-table.tsx`

- **피드백 열** 추가(`환각` 열 바로 뒤, `응답` 앞): `👍`/`👎`/`·`. `min-w-[880px]` → `min-w-[940px]`.
- **정렬 열헤더**: `시각`·`관련도`·`응답`·`토큰` `<th>` 를 `<Link href={href(sp,{sort,dir})}>` 로. 현재 활성 컬럼이면 방향 토글(asc↔desc)하고 `↓/↑` 표시, 아니면 desc 로 시작. `sp` 에 `sort`/`dir` 추가.
- **remount**: `app/admin/page.tsx` 에서 `<LogTable key={filterKey} .../>` — `filterKey` = 필터 파라미터 join 문자열. 필터/정렬 변경 시 append 상태 리셋.
- **더보기 페이징**: `loadMore` 의 쿼리스트링에 `search`/`until`/`sort`/`dir`/`neg` 추가. `sp` 타입 확장.

### E. 상세 패널 — `app/admin/page.tsx`

- `DetailPanel` 그리드에 `Field` 추가:
  - `피드백`: `feedback===1 ? "👍 도움됨" : feedback===-1 ? "👎 아쉬움" : "–"`.
  - `피드백 메모`: `feedback_note` 있을 때만 렌더(질문/답변처럼 whitespace-pre-wrap).

### F. 페이징 API — `app/api/admin/logs/route.ts`

- `sp` 에서 `search`·`until`·`sort`·`dir`·`neg` 파싱. `sort`/`dir` 는 화이트리스트/enum 검증 후 `filter` 로 전달(무효값은 무시 → 기본값).

## 데이터 흐름

```
GET /admin?q=사업비&from=2026-07-01&sort=total_ms&dir=desc&neg=1
  page.tsx: filter = {search:"사업비", since:"2026-07-01T00:00:00", sort:"total_ms", sortDir:"desc", negativeOnly:true}
    ├─ queryLogStats(filter)  → 만족도 등 KPI (동일 모집단)
    ├─ listQueryLogs(filter)  → 초기 10행 (정렬 적용)
    └─ <LogTable key="사업비|...|total_ms|desc">  ← remount
         "더보기" → /api/admin/logs?offset=10&search=사업비&sort=total_ms&dir=desc&neg=1
```

## 검증

- `pnpm build` 통과(타입·린트).
- 로컬 `pnpm dev`:
  - 만족도 KPI 표시(피드백 있는 로그 존재 시 %·미터·분자/분모).
  - 검색어 입력 → 표·통계·"더보기" 동일 모집단.
  - 열헤더 클릭 → 정렬 방향 토글, 첫 페이지 재정렬, 더보기도 같은 정렬 유지.
  - `from`/`to` 입력 → 해당 구간만.
  - `👎만` → feedback=-1 행만.
  - 필터 변경 시 표가 스테일 없이 리셋(remount 확인).
  - 상세 패널에 피드백/메모 표시.
