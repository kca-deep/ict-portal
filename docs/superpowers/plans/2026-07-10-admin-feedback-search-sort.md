# 관리자 콘솔 — 피드백 노출 + 검색·정렬·날짜범위 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이미 수집 중인 `feedback`/`feedback_note` 를 관리자 콘솔에 노출하고, 로그 표에 질문·답변 자유검색·열헤더 정렬·커스텀 날짜범위를 추가한다.

**Architecture:** 세 조회 경로(`listQueryLogs`·`queryLogStats`·`/api/admin/logs`)에 **하나의 공통 필터 헬퍼**를 태워 표·통계·"더보기"가 항상 같은 모집단을 본다. 필터 UI 는 기존 철학(클라JS 없는 `<Link>` 칩)을 유지하되 검색·날짜만 **서버 렌더 GET `<form>`** 으로 추가한다. 정렬은 열헤더 `<Link>` 로 URL 파라미터를 토글하고, `LogTable` 에 필터 해시 `key` 를 줘 URL 변경 시 append 상태를 리셋한다(기존 스테일 버그 동시수정).

**Tech Stack:** Next.js 15 App Router(서버 컴포넌트), TypeScript, Supabase(`@supabase/supabase-js` 쿼리 빌더), Tailwind, recharts(변경 없음).

## Global Constraints

- 스키마 변경 없음(`feedback`·`feedback_note` 컬럼은 이미 존재). DB 마이그레이션 신규 추가 금지.
- `service_role` 조회는 서버(서버 컴포넌트/route handler)에서만. 클라이언트 컴포넌트에서 `lib/db/query-log.ts` import 금지.
- 정렬 컬럼은 **화이트리스트**로만: `created_at`·`top_score`·`total_ms`·`tokens`·`feedback`. 임의 컬럼 문자열을 `.order()` 에 넘기지 않는다.
- 검색어는 PostgREST `or()` 구조문자(`,` `(` `)`)·ilike 와일드카드(`%` `_`)를 중화한 뒤 삽입.
- 용어: 공모 aggregator 관련 없음. 피드백 라벨은 `👍 도움됨`/`👎 아쉬움`.
- 테스트 프레임워크 없음 → 각 태스크 검증은 `pnpm typecheck` → (UI 변경 시) `pnpm build` + 로컬 `pnpm dev` 육안 확인. 커밋 메시지 말미에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- 커밋은 `pnpm build` 통과 후. 빌드 실패 시 중단·보고.

---

## File Structure

| 파일 | 책임 | 태스크 |
|---|---|---|
| `lib/db/query-log.ts` | 필터 타입·공통 필터 헬퍼·정렬 화이트리스트·`feedback` 컬럼/타입·만족도 집계 | 1 |
| `app/api/admin/logs/route.ts` | "더보기" 페이징 API — 신규 파라미터 파싱·검증 후 필터 전달 | 2 |
| `app/admin/page.tsx` | 서버 페이지 — 필터 파싱·만족도 KPI·검색/날짜 폼·👎만 칩·`href` 확장·`LogTable` key·상세 패널 피드백 | 3·4·6 |
| `app/admin/log-table.tsx` | 클라이언트 표 — 피드백 열·정렬 열헤더·더보기 파라미터·Sp 확장 | 5 |
| `app/admin/charts.tsx` | 변경 없음 | — |

---

## Task 1: 데이터 계층 — 필터 확장·공통 헬퍼·피드백·만족도

**Files:**
- Modify: `lib/db/query-log.ts`

**Interfaces:**
- Produces:
  - `QueryLogFilter` 확장: `search?: string`, `until?: string`, `sort?: SortKey`, `sortDir?: "asc" | "desc"`, `negativeOnly?: boolean`
  - `type SortKey = "created_at" | "top_score" | "total_ms" | "tokens" | "feedback"`
  - `QueryLogListItem` 에 `feedback: number | null`
  - `QueryLogDetail` 에 `feedback: number | null`, `feedback_note: string | null`
  - `QueryLogStats` 에 `positiveCount: number`, `ratedCount: number`
  - `listQueryLogs(filter)`·`queryLogStats(filter)` 시그니처 불변(필터만 확장)

- [ ] **Step 1: `QueryLogFilter` 와 `SortKey` 확장**

`QueryLogFilter` 타입을 찾아(현재 `limit`/`offset`/`route`/`hallucinationOnly`/`ip`/`since`) 아래로 교체:

```ts
export type SortKey = "created_at" | "top_score" | "total_ms" | "tokens" | "feedback";

export type QueryLogFilter = {
  limit?: number;
  offset?: number; // 페이징 시작 위치. 지정 시 range(offset, offset+limit-1) 로 조회.
  route?: "regulation" | "law" | "out_of_scope";
  hallucinationOnly?: boolean;
  negativeOnly?: boolean; // feedback = -1 (👎) 만
  ip?: string;
  since?: string; // ISO timestamp — created_at >= since
  until?: string; // ISO timestamp — created_at <= until
  search?: string; // query|answer 부분일치(ilike)
  sort?: SortKey; // 정렬 컬럼(화이트리스트). 기본 created_at
  sortDir?: "asc" | "desc"; // 기본 desc
};
```

- [ ] **Step 2: 검색어 중화 + 공통 필터 헬퍼 + 정렬 매핑 추가**

`QueryLogFilter` 정의 아래(첫 조회 함수 `listQueryLogs` 위)에 삽입:

```ts
// 정렬 화이트리스트 — 키 → 실제 컬럼. tokens 는 합계 컬럼이 없어 tokens_in 으로 근사.
const SORT_COLUMN: Record<SortKey, string> = {
  created_at: "created_at",
  top_score: "top_score",
  total_ms: "total_ms",
  tokens: "tokens_in",
  feedback: "feedback",
};

// PostgREST or() 는 콤마·괄호로 필터를 구분하고 ilike 는 %/_ 가 와일드카드다.
// 검색어의 구조문자는 공백으로, 와일드카드는 백슬래시로 중화해 주입을 막는다(PoC 수준).
function escapeSearch(s: string): string {
  return s.replace(/[%_]/g, "\\$&").replace(/[(),]/g, " ").trim();
}

// where 절(모집단 한정)만 공통으로 적용한다. select 컬럼·정렬·limit 은 호출부가 소유.
// 구조 타이핑으로 빌더 종류에 무관하게 체이닝(반환 타입 T 유지) — supabase 빌더가 만족.
type FilterableQuery<T> = {
  eq(column: string, value: unknown): T;
  gte(column: string, value: unknown): T;
  lte(column: string, value: unknown): T;
  or(filters: string): T;
};

function applyFilter<T extends FilterableQuery<T>>(q: T, filter: QueryLogFilter): T {
  if (filter.route) q = q.eq("route", filter.route);
  if (filter.hallucinationOnly) q = q.eq("has_hallucination", true);
  if (filter.negativeOnly) q = q.eq("feedback", -1);
  if (filter.ip) q = q.eq("ip", filter.ip);
  if (filter.since) q = q.gte("created_at", filter.since);
  if (filter.until) q = q.lte("created_at", filter.until);
  if (filter.search) {
    const kw = escapeSearch(filter.search);
    if (kw) q = q.or(`query.ilike.%${kw}%,answer.ilike.%${kw}%`);
  }
  return q;
}
```

- [ ] **Step 3: `LIST_COLUMNS` 와 `QueryLogListItem` 에 `feedback` 추가**

`LIST_COLUMNS` 상수 끝에 `, feedback` 추가:

```ts
const LIST_COLUMNS =
  "id, created_at, ip, query, route, top_score, has_hallucination, total_ms, ttft_ms, tokens_in, tokens_out, message_count, feedback";
```

`QueryLogListItem` 타입에 필드 추가(`message_count` 아래):

```ts
  message_count: number | null;
  feedback: number | null;
```

- [ ] **Step 4: `QueryLogDetail` 에 `feedback`·`feedback_note` 추가**

`QueryLogDetail` 타입(현재 `... & { answer ... error_code }`)의 `error_code` 아래에 추가:

```ts
  error_code: string | null;
  feedback: number | null;
  feedback_note: string | null;
```

(조회는 이미 `getQueryLog` 가 `select("*")` 라 값은 들어온다 — 타입만 노출.)

- [ ] **Step 5: `listQueryLogs` 를 공통 필터 + 정렬로 교체**

현재 함수 본문의 개별 `if (filter.route) ...` 블록과 `.order("created_at", ...)` 를 아래로 교체:

```ts
export async function listQueryLogs(
  filter: QueryLogFilter = {},
): Promise<QueryLogListItem[]> {
  const limit = filter.limit ?? 100;
  const sortCol = SORT_COLUMN[filter.sort ?? "created_at"];
  const ascending = filter.sortDir === "asc";

  let q = getSupabaseAdmin()
    .from("query_log")
    .select(LIST_COLUMNS)
    .order(sortCol, { ascending });
  q = applyFilter(q, filter);

  // offset 이 있으면 range(페이징), 없으면 상위 limit 건.
  q =
    filter.offset != null
      ? q.range(filter.offset, filter.offset + limit - 1)
      : q.limit(limit);

  const { data, error } = await q;
  if (error) throw new Error(`[query-log] list failed: ${error.message}`);
  return (data ?? []) as unknown as QueryLogListItem[];
}
```

- [ ] **Step 6: `queryLogStats` 에 공통 필터 + 피드백 집계**

`queryLogStats` 의 select 문자열 끝에 `, feedback` 추가하고, 개별 `if (filter.route) ...` 블록을 `q = applyFilter(q, filter);` 한 줄로 교체. select 는 `.order("created_at", { ascending: false }).limit(STATS_ROW_CAP)` 유지(정렬 파라미터는 통계 창에 영향 없음):

```ts
  let q = getSupabaseAdmin()
    .from("query_log")
    .select(
      "ip, created_at, route, has_hallucination, total_ms, ttft_ms, citation_count, citation_verified_count, error_code, feedback",
    )
    .order("created_at", { ascending: false })
    .limit(STATS_ROW_CAP);
  q = applyFilter(q, filter);
```

row 타입(인라인 `Array<{...}>`)에 `feedback: number | null;` 추가. 집계 카운터 초기화부에 추가:

```ts
  let positiveCount = 0;
  let ratedCount = 0;
```

루프 안(`if (r.has_hallucination) hallucinationCount += 1;` 근처)에 추가:

```ts
    if (r.feedback === 1) {
      positiveCount += 1;
      ratedCount += 1;
    } else if (r.feedback === -1) {
      ratedCount += 1;
    }
```

- [ ] **Step 7: `QueryLogStats` 타입과 반환 객체에 만족도 카운트 추가**

`QueryLogStats` 타입에 필드 추가(`errorCount` 근처):

```ts
  errorCount: number; // error_code 가 있는 요청 수
  positiveCount: number; // 👍(+1) 수
  ratedCount: number; // 평가된(👍/👎) 수 = 만족도 분모
```

`return { ... }` 객체에 추가:

```ts
    errorCount,
    positiveCount,
    ratedCount,
```

- [ ] **Step 8: 타입 검증**

Run: `pnpm typecheck`
Expected: 에러 없음(PASS). `applyFilter` 구조 타이핑이 supabase 빌더에서 통과해야 한다. 실패 시(빌더가 `FilterableQuery` 제약을 만족 못 하면) `FilterableQuery` 의 메서드 시그니처를 실제 빌더 오류 메시지에 맞춰 조정.

- [ ] **Step 9: 커밋**

```bash
git add lib/db/query-log.ts
git commit -m "feat(admin): query-log 필터에 검색·정렬·날짜·피드백 추가

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 페이징 API — 신규 파라미터 파싱

**Files:**
- Modify: `app/api/admin/logs/route.ts`

**Interfaces:**
- Consumes: `QueryLogFilter`(Task 1)의 `search`/`until`/`sort`/`sortDir`/`negativeOnly`, `SortKey`
- Produces: `GET /api/admin/logs` 가 `search`·`until`·`sort`·`dir`·`neg` 쿼리파라미터를 수용

- [ ] **Step 1: import 에 `SortKey` 추가**

```ts
import { listQueryLogs, type QueryLogFilter, type SortKey } from "@/lib/db/query-log";
```

- [ ] **Step 2: 파라미터 파싱·검증 후 필터에 반영**

기존 `const filter: QueryLogFilter = { ... }` 를 아래로 교체(`route` 파싱 로직은 그대로 위에 있음):

```ts
  const sortParam = sp.get("sort");
  const sort: SortKey | undefined = (
    ["created_at", "top_score", "total_ms", "tokens", "feedback"] as const
  ).includes(sortParam as SortKey)
    ? (sortParam as SortKey)
    : undefined;
  const dirParam = sp.get("dir");
  const sortDir = dirParam === "asc" ? "asc" : dirParam === "desc" ? "desc" : undefined;

  const filter: QueryLogFilter = {
    limit: PAGE,
    offset,
    route,
    hallucinationOnly: sp.get("halluc") === "1",
    negativeOnly: sp.get("neg") === "1",
    ip: sp.get("ip") ?? undefined,
    since: sp.get("since") ?? undefined,
    until: sp.get("until") ?? undefined,
    search: sp.get("search") ?? undefined,
    sort,
    sortDir,
  };
```

- [ ] **Step 3: 타입 검증**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: 런타임 스모크(선택, dev 실행 중일 때)**

Run: `curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/api/admin/logs?offset=0"`
Expected: `401`(쿠키 없음 → 인증 실패). 정상 — 인증 게이트가 살아있음을 확인.

- [ ] **Step 5: 커밋**

```bash
git add app/api/admin/logs/route.ts
git commit -m "feat(admin): 로그 페이징 API 검색·정렬·날짜 파라미터 수용

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 만족도 KPI — 품질 스트립 5칸

**Files:**
- Modify: `app/admin/page.tsx`

**Interfaces:**
- Consumes: `QueryLogStats.positiveCount`·`ratedCount`(Task 1), 기존 `pct`/`pctNum` 포매터, 기존 `Kpi` 컴포넌트

- [ ] **Step 1: 품질 스트립 그리드를 5칸으로**

품질 스트립 컨테이너(현재 `className="grid grid-cols-2 border-t border-border bg-muted/40 sm:grid-cols-4"`)의 `sm:grid-cols-4` → `sm:grid-cols-5`:

```tsx
        <div className="grid grid-cols-2 border-t border-border bg-muted/40 sm:grid-cols-5">
```

- [ ] **Step 2: 만족도 `Kpi` 추가**

오류율 `Kpi`(마지막) 바로 아래, 닫는 `</div>` 앞에 추가:

```tsx
            <Kpi
              label="만족도"
              value={stats.ratedCount ? `👍 ${pct(stats.positiveCount, stats.ratedCount)}` : "–"}
              note={`${stats.positiveCount.toLocaleString()}/${stats.ratedCount.toLocaleString()}`}
              meter={pctNum(stats.positiveCount, stats.ratedCount)}
              meterColor="var(--primary)"
            />
```

- [ ] **Step 3: 빌드**

Run: `pnpm build`
Expected: 빌드 성공.

- [ ] **Step 4: 육안 확인**

Run(별도 터미널): `pnpm dev` → 로그인 후 `/admin`.
Expected: 품질 스트립이 5칸(응답시간·환각률·인용검증·오류율·만족도). 피드백 있는 로그가 있으면 `👍 NN%` + 미터 + `분자/분모`; 없으면 `–`, 미터 0.

- [ ] **Step 5: 커밋**

```bash
git add app/admin/page.tsx
git commit -m "feat(admin): 품질 스트립에 만족도 KPI 추가

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 필터 바 — 검색 폼·커스텀 날짜·👎만·href 확장

**Files:**
- Modify: `app/admin/page.tsx`

**Interfaces:**
- Consumes: `first()`, `sinceFromPeriod()`, 기존 `href()`
- Produces: 페이지가 `q`/`from`/`to`/`sort`/`dir`/`neg` searchParam 을 파싱해 `filter` 로 전달하고, `href()` 가 이 키들을 보존

- [ ] **Step 1: searchParam 파싱 + `filter` 확장**

`AdminPage` 상단(현재 `const selectedId = ...` 아래)에 추가:

```ts
  const search = first(sp.q);
  const from = first(sp.from); // YYYY-MM-DD
  const to = first(sp.to);
  const negativeOnly = first(sp.neg) === "1";
  const sortParam = first(sp.sort);
  const sort =
    sortParam === "created_at" ||
    sortParam === "top_score" ||
    sortParam === "total_ms" ||
    sortParam === "tokens" ||
    sortParam === "feedback"
      ? sortParam
      : undefined;
  const dirParam = first(sp.dir);
  const sortDir = dirParam === "asc" ? "asc" : dirParam === "desc" ? "desc" : undefined;

  // 커스텀 날짜가 있으면 프리셋보다 우선. to 는 그날 끝(23:59:59)까지 포함.
  const since = from ? `${from}T00:00:00` : sinceFromPeriod(period);
  const until = to ? `${to}T23:59:59` : undefined;
```

기존 `const filter: QueryLogFilter = { ... }` 를 아래로 교체:

```ts
  const filter: QueryLogFilter = {
    limit: 10,
    route,
    hallucinationOnly,
    negativeOnly,
    ip,
    since,
    until,
    search,
    sort,
    sortDir,
  };
```

- [ ] **Step 2: `href()` 병합 키 확장**

`href()` 헬퍼의 `merged` 객체에 키 추가(기존 `period`/`route`/`halluc`/`ip`/`log` 옆):

```ts
  const merged: Record<string, string | undefined> = {
    period: first(sp.period),
    route: first(sp.route),
    halluc: first(sp.halluc),
    neg: first(sp.neg),
    ip: first(sp.ip),
    q: first(sp.q),
    from: first(sp.from),
    to: first(sp.to),
    sort: first(sp.sort),
    dir: first(sp.dir),
    log: first(sp.log),
    ...patch,
  };
```

- [ ] **Step 3: 검색·날짜 GET 폼 추가**

필터 `<section>`(현재 `분기` 칩들이 있는 섹션) **맨 위**, 여는 태그 바로 다음에 폼을 추가. 폼은 서버 렌더 GET 이라 클라JS 불필요. 기존 필터 상태는 hidden 으로 보존(값 있을 때만 렌더):

```tsx
        <form method="get" action="/admin" className="flex w-full flex-wrap items-center gap-2">
          {period && <input type="hidden" name="period" value={period} />}
          {route && <input type="hidden" name="route" value={route} />}
          {hallucinationOnly && <input type="hidden" name="halluc" value="1" />}
          {negativeOnly && <input type="hidden" name="neg" value="1" />}
          {ip && <input type="hidden" name="ip" value={ip} />}
          {sort && <input type="hidden" name="sort" value={sort} />}
          {sortDir && <input type="hidden" name="dir" value={sortDir} />}
          <input
            type="search"
            name="q"
            defaultValue={search ?? ""}
            placeholder="질문·답변 검색"
            className="w-56 rounded-md border border-border bg-card px-3 py-1.5 text-[13px] outline-none focus:border-primary"
          />
          <input
            type="date"
            name="from"
            defaultValue={from ?? ""}
            className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[13px] text-muted-foreground outline-none focus:border-primary"
          />
          <span className="text-muted-foreground/60">~</span>
          <input
            type="date"
            name="to"
            defaultValue={to ?? ""}
            className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[13px] text-muted-foreground outline-none focus:border-primary"
          />
          <button
            type="submit"
            className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition hover:opacity-90"
          >
            조회
          </button>
        </form>
```

- [ ] **Step 4: `👎만` 칩 추가**

`환각만` `<Link>` 바로 아래에 추가:

```tsx
          <Link
            href={href(sp, { neg: negativeOnly ? undefined : "1", log: undefined })}
            className={`rounded-md px-2.5 py-1 transition ${
              negativeOnly
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            👎만
          </Link>
```

- [ ] **Step 5: 빌드 + 육안 확인**

Run: `pnpm build`
Expected: 성공.

`pnpm dev` → `/admin`:
Expected:
- 검색어 입력 후 `조회` → URL 에 `?q=...`, 표·상단 KPI 모두 해당 검색 모집단.
- `from`/`to` 지정 → 해당 구간만. 프리셋 버튼보다 우선.
- `👎만` 토글 → `feedback=-1` 행만.
- 검색·날짜·필터를 섞어도 서로 보존됨(hidden + href).

- [ ] **Step 6: 커밋**

```bash
git add app/admin/page.tsx
git commit -m "feat(admin): 로그 검색·커스텀 날짜·👎만 필터 추가

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 로그 표 — 피드백 열·정렬 열헤더·remount·더보기 파라미터

**Files:**
- Modify: `app/admin/log-table.tsx`
- Modify: `app/admin/page.tsx` (LogTable 호출부 — `key`·`sp` 확장)

**Interfaces:**
- Consumes: `QueryLogListItem.feedback`(Task 1), 페이지가 넘기는 확장 `sp` + `since`/`until`
- Produces: 표가 정렬 상태를 URL 로 토글하고, "더보기"가 검색·정렬·날짜를 유지

- [ ] **Step 1: `Sp` 타입 확장**

`log-table.tsx` 의 `type Sp = { period?; route?; halluc?; ip? }` 를 교체:

```ts
type Sp = {
  period?: string;
  route?: string;
  halluc?: string;
  neg?: string;
  ip?: string;
  q?: string;
  from?: string;
  to?: string;
  sort?: string;
  dir?: string;
};
```

- [ ] **Step 2: `href()` 병합 키 확장**

`log-table.tsx` 내부 `href()` 의 `merged` 객체를 교체:

```ts
  const merged: Record<string, string | undefined> = {
    period: sp.period,
    route: sp.route,
    halluc: sp.halluc,
    neg: sp.neg,
    ip: sp.ip,
    q: sp.q,
    from: sp.from,
    to: sp.to,
    sort: sp.sort,
    dir: sp.dir,
    ...patch,
  };
```

- [ ] **Step 3: `LogTable` props 에 `until` 추가 + 더보기 파라미터 확장**

`LogTable` 시그니처에 `until` 추가:

```tsx
export function LogTable({
  initialRows,
  sp,
  since,
  until,
  selectedId,
}: {
  initialRows: QueryLogListItem[];
  sp: Sp;
  since?: string;
  until?: string;
  selectedId?: number;
}) {
```

`loadMore` 의 `URLSearchParams` 구성부(현재 route/halluc/ip/since 만)를 교체:

```ts
      const p = new URLSearchParams();
      p.set("offset", String(rows.length));
      if (sp.route) p.set("route", sp.route);
      if (sp.halluc) p.set("halluc", sp.halluc);
      if (sp.neg) p.set("neg", sp.neg);
      if (sp.ip) p.set("ip", sp.ip);
      if (sp.q) p.set("search", sp.q);
      if (sp.sort) p.set("sort", sp.sort);
      if (sp.dir) p.set("dir", sp.dir);
      if (since) p.set("since", since);
      if (until) p.set("until", until);
```

- [ ] **Step 4: 정렬 열헤더 컴포넌트 추가**

`log-table.tsx` 의 `RoutePill` 아래에 추가:

```tsx
// 정렬 가능한 열헤더. 활성 컬럼이면 방향(↓/↑)을 보이고 클릭 시 토글, 아니면 desc 로 시작.
// 기본 정렬은 created_at desc 이라 sort 미지정 시 '시각' 이 활성으로 간주된다.
function SortTh({
  sp,
  col,
  label,
  align,
}: {
  sp: Sp;
  col: "created_at" | "top_score" | "total_ms" | "tokens";
  label: string;
  align: "left" | "right";
}) {
  const active = sp.sort === col || (!sp.sort && col === "created_at");
  const dir = active ? (sp.dir === "asc" ? "asc" : "desc") : "desc";
  const nextDir = active && dir === "desc" ? "asc" : "desc";
  const arrow = active ? (dir === "desc" ? " ↓" : " ↑") : "";
  return (
    <th className={`px-4 py-2.5 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      <Link
        href={href(sp, { sort: col, dir: nextDir, log: undefined })}
        className={`transition hover:text-foreground ${active ? "text-foreground" : ""}`}
      >
        {label}
        <span className="tabular-nums">{arrow}</span>
      </Link>
    </th>
  );
}
```

- [ ] **Step 5: `<thead>` 를 정렬 열헤더로 교체 + 피드백 열 추가**

기존 `<thead>...</thead>` 전체를 교체(시각·관련도·응답·토큰은 `SortTh`, 피드백 열은 `환각` 뒤):

```tsx
          <thead>
            <tr className="border-b border-border bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
              <SortTh sp={sp} col="created_at" label="시각" align="left" />
              <th className="px-4 py-2.5 text-left font-medium">IP</th>
              <th className="px-4 py-2.5 text-left font-medium">질문</th>
              <th className="px-4 py-2.5 text-left font-medium">분기</th>
              <SortTh sp={sp} col="top_score" label="관련도" align="right" />
              <th className="px-4 py-2.5 text-center font-medium">환각</th>
              <th className="px-4 py-2.5 text-center font-medium">피드백</th>
              <SortTh sp={sp} col="total_ms" label="응답" align="right" />
              <SortTh sp={sp} col="tokens" label="토큰" align="right" />
            </tr>
          </thead>
```

- [ ] **Step 6: 표 폭·빈 상태 colSpan·피드백 셀 반영**

테이블 `className` 의 `min-w-[880px]` → `min-w-[940px]`:

```tsx
        <table className="w-full min-w-[940px] border-collapse text-[13px]">
```

빈 상태 행 `colSpan={8}` → `colSpan={9}`:

```tsx
                <td colSpan={9} className="px-4 py-14 text-center text-muted-foreground">
```

`환각` 셀(`<td ...>{r.has_hallucination ? ... : ...}</td>`) 바로 뒤에 피드백 셀 추가:

```tsx
                <td className="whitespace-nowrap px-4 py-2.5 text-center">
                  {r.feedback === 1 ? (
                    <span title="도움됨">👍</span>
                  ) : r.feedback === -1 ? (
                    <span title="아쉬움">👎</span>
                  ) : (
                    <span className="text-muted-foreground/30">·</span>
                  )}
                </td>
```

- [ ] **Step 7: 페이지 호출부 — `key`·`until`·확장 `sp` 전달**

`app/admin/page.tsx` 의 `<LogTable ... />` 호출을 교체:

```tsx
        <LogTable
          key={[period, route, hallucinationOnly, negativeOnly, ip, search, from, to, sort, sortDir]
            .map((v) => v ?? "")
            .join("|")}
          initialRows={rows}
          sp={{
            period,
            route,
            halluc: hallucinationOnly ? "1" : undefined,
            neg: negativeOnly ? "1" : undefined,
            ip,
            q: search,
            from,
            to,
            sort,
            dir: sortDir,
          }}
          since={filter.since}
          until={filter.until}
          selectedId={selectedId}
        />
```

- [ ] **Step 8: 빌드 + 육안 확인**

Run: `pnpm build`
Expected: 성공.

`pnpm dev` → `/admin`:
Expected:
- `피드백` 열에 👍/👎/· 표시.
- `시각`·`관련도`·`응답`·`토큰` 헤더 클릭 → 정렬 방향 토글(↓↔↑), 표 재정렬.
- 정렬·필터 변경 시 표가 **스테일 없이 리셋**(remount) — 이전 "더보기"로 쌓인 행이 사라지고 새 모집단 첫 페이지부터.
- `더보기` → 현재 검색·정렬·날짜를 유지한 다음 페이지.

- [ ] **Step 9: 커밋**

```bash
git add app/admin/log-table.tsx app/admin/page.tsx
git commit -m "feat(admin): 로그 표 피드백 열·정렬 헤더·필터 remount

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 상세 패널 — 피드백·메모

**Files:**
- Modify: `app/admin/page.tsx`

**Interfaces:**
- Consumes: `QueryLogDetail.feedback`·`feedback_note`(Task 1), 기존 `Field` 컴포넌트

- [ ] **Step 1: `DetailPanel` 그리드에 피드백 `Field` 추가**

`DetailPanel` 의 필드 그리드(`게이트 충족` `Field` 근처, `error_code` 조건부 필드 앞)에 추가:

```tsx
        <Field label="피드백">
          {detail.feedback === 1 ? (
            <span className="font-semibold text-primary">👍 도움됨</span>
          ) : detail.feedback === -1 ? (
            <span className="font-semibold text-destructive">👎 아쉬움</span>
          ) : (
            "–"
          )}
        </Field>
```

- [ ] **Step 2: 피드백 메모 블록 추가(있을 때만)**

`DetailPanel` 의 질문/답변 블록(`mt-5 space-y-4` 컨테이너) 안, `답변` 블록 아래에 추가:

```tsx
        {detail.feedback_note && (
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              피드백 메모
            </div>
            <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground/90">
              {detail.feedback_note}
            </p>
          </div>
        )}
```

- [ ] **Step 3: 빌드 + 육안 확인**

Run: `pnpm build`
Expected: 성공.

`pnpm dev` → `/admin` → 로그 행 클릭:
Expected: 상세 패널에 `피드백`(👍/👎/–) 필드. `feedback_note` 가 있는 로그면 `피드백 메모` 블록 표시.

- [ ] **Step 4: 커밋**

```bash
git add app/admin/page.tsx
git commit -m "feat(admin): 로그 상세에 피드백·메모 표시

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (작성자 체크)

**Spec coverage:**
- A. 데이터 계층(필터·헬퍼·정렬·feedback·만족도) → Task 1 ✅
- B. 만족도 KPI 5칸 → Task 3 ✅
- C. 필터 바(검색 폼·커스텀 날짜·👎만·href) → Task 4 ✅
- D. 로그 표(피드백 열·정렬 헤더·remount·더보기) → Task 5 ✅
- E. 상세 패널(피드백·메모) → Task 6 ✅
- F. 페이징 API → Task 2 ✅

**스펙과의 의도적 편차(합리화):**
- 스펙은 `queryLogStats` 가 `satisfactionPct` 를 반환한다고 했으나, 계획은 `positiveCount`/`ratedCount` 만 반환하고 `%` 는 페이지에서 기존 `pct`/`pctNum` 포매터로 파생한다(환각률·오류율 KPI 와 동일 패턴 재사용 → DRY). 결과 동일.

**Type consistency:**
- `SortKey` = `"created_at" | "top_score" | "total_ms" | "tokens" | "feedback"` — Task 1 정의, Task 2(API enum)·Task 4(page 파싱)·Task 5(`SortTh` col)에서 동일 값 사용. `SortTh.col` 은 `feedback` 제외(피드백 열은 정렬 헤더 아님) — 부분집합이라 타입 호환 ✅.
- `feedback: number | null` — `QueryLogListItem`(Task1)·표 셀(Task5)·상세(Task6) 일관 ✅.
- `applyFilter` 반환 타입 `T` 유지 → `listQueryLogs`/`queryLogStats` 에서 `.range`/`.limit` 체이닝 지속 가능 ✅.

**Placeholder scan:** 모든 코드 스텝에 실제 코드 포함, TBD/TODO 없음 ✅.

**주의(실행자 참고):** `applyFilter` 의 구조 타이핑(`FilterableQuery<T>`)이 supabase 빌더 버전에서 통과하지 않으면(Step 8 typecheck 실패), 헬퍼를 제거하고 동일 where 블록을 `listQueryLogs`·`queryLogStats` 두 곳에 인라인 복제하는 것으로 폴백(모집단 동일성만 유지되면 됨). 이는 CLAUDE.md "불필요한 추상화 금지" 와도 부합하는 안전한 폴백.
