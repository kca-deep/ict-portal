# 관리자 대시보드 1년 상한 전체 집계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드 통계의 5,000행 사일런트 캡을 제거하고, 집계 기간을 1년 상한(토글 24시간/7일/30일/1년)으로 개편한다.

**Architecture:** `queryLogStats`가 `.range()` 기반 1,000행 청크 페이지네이션으로 조회 창 내 전 행을 가져와 기존 JS 집계 로직을 그대로 태운다. UI는 기간 토글에서 "전체"를 없애고 미지정 기본을 1년으로 강등하며, 커스텀 `from`은 1년 전으로 클램프한다. 추이 차트는 조회 창 크기에 따라 시간별/일별/주별 버킷을 쓴다.

**Tech Stack:** Next.js 15 App Router(서버 컴포넌트) · Supabase JS(`.range()`) · TypeScript

## Global Constraints

- 테스트 셋업 없음(PoC) — 검증 기준은 `pnpm typecheck` + `pnpm build` (CLAUDE.md).
- DB 스키마 변경 없음(마이그레이션 없음 — JS 페이지네이션 방식으로 사용자 확정).
- `listQueryLogs`(로그 표)는 불변 — 자체 페이지네이션 보유.
- 커밋·푸시는 사용자 명시 요청 시에만 수행(세션 정책). 계획 완료 후 보고만 한다.
- 스펙: `docs/superpowers/specs/2026-07-20-admin-stats-1y-full-aggregation-design.md`

---

### Task 1: `queryLogStats` 청크 페이지네이션 + `truncated` + 추이 버킷 확장

**Files:**
- Modify: `lib/db/query-log.ts` (타입 `QueryLogStats` ~205행, `buildUsageSeries` ~241행, `STATS_ROW_CAP` 271행, `queryLogStats` ~292행)

**Interfaces:**
- Consumes: 기존 `applyFilter(q, filter)`, `getSupabaseAdmin()`, 집계 루프 본문(불변).
- Produces: `QueryLogStats.truncated: boolean` 필드(Task 2의 배지가 읽음). `buildUsageSeries`는 주별 버킷 지원(시그니처 불변).

- [ ] **Step 1: `QueryLogStats` 타입에 `truncated` 추가**

`lib/db/query-log.ts`의 `QueryLogStats` 타입에서 `api: ApiUsageStats;` 줄 앞에 추가:

```ts
  // 안전핀(최대 10만 행) 도달로 집계가 잘렸는지 여부. true 면 UI 에 배지 표시.
  truncated: boolean;
```

- [ ] **Step 2: `buildUsageSeries` 버킷 3단계로 개편(30일 하드컷 제거)**

기존 `buildUsageSeries` 함수 본문의 버킷 결정부:

```ts
  const hourly = now - start <= 2 * 24 * 3600 * 1000;
  const bucketMs = hourly ? 3600 * 1000 : 24 * 3600 * 1000;
  if (!hourly) {
    const maxSpan = 30 * 24 * 3600 * 1000; // 일별 버킷 개수 상한
    if (now - start > maxSpan) start = now - maxSpan;
  }
```

를 다음으로 교체(주석 갱신 포함 — 함수 위 주석 "그 이상이면 일별(최근 30일 상한)"도 "90일 이내면 일별, 그 이상이면 주별"로 수정):

```ts
  // 조회 창 크기에 따라 버킷 선택: ≤2일 시간별 · ≤90일 일별 · 그 이상 주별(1년 ≈ 52포인트).
  const DAY_MS = 24 * 3600 * 1000;
  const span = now - start;
  const hourly = span <= 2 * DAY_MS;
  const bucketMs = hourly ? 3600 * 1000 : span <= 90 * DAY_MS ? DAY_MS : 7 * DAY_MS;
```

라벨부는 불변 — 일별·주별 모두 기존 `M/D` 라벨(`d.getMonth() + 1}/${d.getDate()`)을 그대로 쓴다(주별은 버킷 시작일이 라벨이 됨).

- [ ] **Step 3: `queryLogStats` 조회를 청크 페이지네이션으로 교체**

`STATS_ROW_CAP` 상수(271행)와 그 주석을 다음으로 교체:

```ts
// 집계는 조회 창(≤1년) 내 전 행 대상 — 1,000행 청크로 나눠 가져와 JS 에서 접는다.
// PoC 규모라 RPC 승격 없이 충분. MAX 도달 시 truncated 로 UI 에 알린다(무표시 잘림 금지).
const STATS_CHUNK = 1000;
const STATS_MAX_CHUNKS = 100; // 안전핀: 100 × 1,000 = 10만 행
```

`queryLogStats` 함수 앞부분(현재 `let q = getSupabaseAdmin()...` 부터 `if (error) throw ...` 까지)을 다음으로 교체. `rows` 변수는 기존 캐스팅 타입을 그대로 재사용하되 청크 누적으로 채운다:

```ts
  type StatsRow = {
    ip: string | null;
    created_at: string;
    route: string | null;
    has_hallucination: boolean | null;
    total_ms: number | null;
    ttft_ms: number | null;
    citation_count: number | null;
    citation_verified_count: number | null;
    error_code: string | null;
    feedback: number | null;
    tokens_in: number | null;
    tokens_out: number | null;
    api_usage: Record<string, number> | null;
  };

  const rows: StatsRow[] = [];
  let truncated = false;
  for (let chunk = 0; chunk < STATS_MAX_CHUNKS; chunk++) {
    let q = getSupabaseAdmin()
      .from("query_log")
      .select(
        "ip, created_at, route, has_hallucination, total_ms, ttft_ms, citation_count, citation_verified_count, error_code, feedback, tokens_in, tokens_out, api_usage",
      )
      // created_at 동률 행에서 페이지 경계가 흔들리지 않도록 id 를 2차 정렬키로 고정.
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(chunk * STATS_CHUNK, (chunk + 1) * STATS_CHUNK - 1);
    q = applyFilter(q, filter);

    const { data, error } = await q;
    if (error) throw new Error(`[query-log] stats failed: ${error.message}`);
    const page = (data ?? []) as unknown as StatsRow[];
    rows.push(...page);
    if (page.length < STATS_CHUNK) break;
    if (chunk === STATS_MAX_CHUNKS - 1) truncated = true;
  }
```

기존의 `const rows = (data ?? []) as unknown as Array<{...}>;` 블록은 위 `StatsRow` 로 대체되므로 삭제한다. 이후 집계 루프(`for (const r of rows)`)와 공휴일 조회는 불변.

- [ ] **Step 4: 반환 객체에 `truncated` 포함**

`queryLogStats` 의 `return { ... }` 에서 `api,` 앞에 한 줄 추가:

```ts
    truncated,
```

- [ ] **Step 5: 타입 검사**

Run: `pnpm typecheck`
Expected: 에러 0 (`app/admin/page.tsx` 는 아직 `truncated` 를 안 읽으므로 영향 없음)

---

### Task 2: 기간 토글 개편 + 커스텀 날짜 1년 클램프 + 배지

**Files:**
- Modify: `app/admin/page.tsx` (`sinceFromPeriod` 47행, 기간 파싱 ~136행, `periods`/`periodLabel` ~170행, 계기판 헤더 ~213행)

**Interfaces:**
- Consumes: Task 1의 `stats.truncated: boolean`.
- Produces: 없음(말단 UI).

- [ ] **Step 1: `sinceFromPeriod` 를 항상 ISO 반환(기본=1년 전)으로 변경**

기존:

```ts
function sinceFromPeriod(period: string | undefined): string | undefined {
  const now = Date.now();
  if (period === "24h") return new Date(now - 24 * 3600 * 1000).toISOString();
  if (period === "7d") return new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  return undefined;
}
```

교체:

```ts
// 기간 프리셋 → since ISO. "전체" 제거 — 미지정 기본은 최근 1년(집계 상한).
const YEAR_MS = 365 * 24 * 3600 * 1000;
function sinceFromPeriod(period: string | undefined): string {
  const now = Date.now();
  if (period === "24h") return new Date(now - 24 * 3600 * 1000).toISOString();
  if (period === "7d") return new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  if (period === "30d") return new Date(now - 30 * 24 * 3600 * 1000).toISOString();
  return new Date(now - YEAR_MS).toISOString();
}
```

- [ ] **Step 2: 커스텀 `from` 1년 클램프**

기존(136행 근처):

```ts
  // 커스텀 날짜가 있으면 프리셋보다 우선. to 는 그날 끝(23:59:59)까지 포함.
  const since = from ? `${from}T00:00:00` : sinceFromPeriod(period);
  const until = to ? `${to}T23:59:59` : undefined;
```

교체:

```ts
  // 커스텀 날짜가 있으면 프리셋보다 우선하되 하한은 1년 전(집계 상한). to 는 그날 끝까지.
  const oneYearAgoIso = new Date(Date.now() - YEAR_MS).toISOString();
  const fromIso = from ? `${from}T00:00:00` : undefined;
  const fromClamped =
    fromIso != null && new Date(fromIso).getTime() < Date.now() - YEAR_MS;
  const since = fromIso == null ? sinceFromPeriod(period) : fromClamped ? oneYearAgoIso : fromIso;
  const until = to ? `${to}T23:59:59` : undefined;
```

- [ ] **Step 3: 토글·라벨 개편**

기존:

```ts
  const periods: Array<[string, string | undefined]> = [
    ["24시간", "24h"],
    ["7일", "7d"],
    ["전체", undefined],
  ];
```

교체:

```ts
  const periods: Array<[string, string | undefined]> = [
    ["24시간", "24h"],
    ["7일", "7d"],
    ["30일", "30d"],
    ["1년", undefined], // 미지정 기본 = 1년(구 "전체" 링크도 자연 강등)
  ];
```

`periodLabel` 교체:

```ts
  const periodLabel =
    period === "24h" ? "최근 24시간" : period === "7d" ? "최근 7일" : period === "30d" ? "최근 30일" : "최근 1년";
```

주의: `period` 파싱은 `first(sp.period)` 그대로 둔다 — `period="30d"` 는 `sinceFromPeriod` 가 처리하고, 알 수 없는 값은 기본(1년)으로 떨어져 안전하다.

- [ ] **Step 4: 클램프 안내 + truncated 배지**

계기판 좌측 패널의 기간 토글 헤더 블록 바로 아래(`</div>` 닫힌 뒤, `mt-5 grid grid-cols-3` HeroStat 그리드 앞)에 삽입:

```tsx
              {(fromClamped || stats.truncated) && (
                <div className="mt-2 text-[11px] text-muted-foreground/80">
                  {fromClamped && <span>1년 이전 데이터는 집계에서 제외됩니다. </span>}
                  {stats.truncated && (
                    <span className="text-destructive">
                      집계 상한(100,000건) 도달 — 최근 100,000건만 반영됨.
                    </span>
                  )}
                </div>
              )}
```

- [ ] **Step 5: 검증 — 타입·빌드**

Run: `pnpm typecheck && pnpm build`
Expected: 둘 다 통과. 빌드 실패 시 중단·보고(CLAUDE.md).

- [ ] **Step 6: 로컬 동작 확인(`pnpm dev`)**

`pnpm dev` 후 `/admin` 에서:
1. 토글 4종(24시간/7일/30일/1년) 노출·활성 표시 확인 — 파라미터 없음 = "1년" 활성.
2. `?period=30d` 로 사용량 숫자가 1년 대비 줄어드는지 확인.
3. 커스텀 from 에 1년 이전 날짜(예: 2024-01-01) 입력 → "1년 이전 데이터는 집계에서 제외됩니다" 문구 확인.
4. 추이 차트: 7일=일별, 1년=주별 라벨(M/D) 전환 확인.
5. (데이터 5천건 미만 환경) 숫자가 기존과 동일한지 — 회귀 없음 확인.

---

## Self-Review 결과

- 스펙 커버리지: 토글 개편(T2S1·S3)·클램프+안내(T2S2·S4)·페이지네이션+안전핀+배지(T1S3·S4, T2S4)·차트 버킷(T1S2) — 전 항목 매핑됨.
- 플레이스홀더 없음, 타입 일관성: `truncated: boolean` 생산(T1)=소비(T2) 일치.
- 스코프: 파일 2개, 단일 PR 적정(스키마 변경 없음 — CLAUDE.md 단독 PR 규칙 비해당).
