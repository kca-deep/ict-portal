import Link from "next/link";
import {
  listQueryLogs,
  queryLogStats,
  getQueryLog,
  type QueryLogFilter,
  type QueryLogStats,
} from "@/lib/db/query-log";
import { UsageChart, RouteDonut } from "./charts";
import { LogoutButton } from "./logout-button";
import { Response } from "@/components/ui/response";
import { LogTable } from "./log-table";
import { PageSizeSelect } from "./page-size-select";
import { getKoreanHolidaysForYears } from "@/lib/holidays";

// 관리자 대시보드(쿼리로그 뷰어). 미들웨어(/admin 게이트)가 서명 쿠키를 통과시킨
// 요청만 도달한다. 데이터는 전부 서버에서 service_role 로만 읽으므로 그 키가
// 브라우저로 나가지 않는다. 필터는 GET 쿼리 파라미터로 처리(클라이언트 JS 불필요).
// 테마: PIMS 웜 페이퍼 + 잉크블루 + 출처색(규정=블루 / 법령=앰버). globals.css 토큰 사용.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SearchParams = { [key: string]: string | string[] | undefined };

const ROUTE_META: Record<
  "unified" | "regulation" | "law" | "out_of_scope",
  { label: string; color: string }
> = {
  // 통합 검색(2026-07 개편 이후 기본 라우트). 규정 블루·법령 앰버와 구분되는 틸.
  unified: { label: "통합", color: "oklch(0.55 0.11 170)" },
  // regulation/law 는 개편 전 레거시 행 표시용.
  regulation: { label: "규정", color: "var(--badge-regulation)" },
  law: { label: "법령", color: "var(--badge-law)" },
  out_of_scope: { label: "범위밖", color: "var(--muted-foreground)" },
};

// 미분류(route 미기록) 버킷. total 에는 포함되므로 도넛·범례에도 반드시 나타나야
// 합이 100% 가 된다. 범위밖(진한 회색)과 구분되도록 더 밝은 중성색을 쓴다.
// 미분류(route 미기록) 색. 도넛(charts.tsx routeConfig.unknown)과 반드시 동일해야
// 범례와 색이 일치한다.
const UNKNOWN_META = {
  label: "미분류",
  color: "oklch(0.72 0.02 75)",
};

// ── 포매터 ──────────────────────────────────────────────────────────────────
// 슬러그 모드(ADMIN_PATH_SECRET)에서는 브라우저 노출 경로가 /{slug} 이므로 내부 링크도
// 그 기준으로 생성한다(미들웨어가 /{slug}/* → /admin/* rewrite). 미설정이면 /admin.
// 앞뒤 슬래시는 정규화(미들웨어와 동일 규칙 — 설정 실수 방어).
const ADMIN_PATH_SLUG = (process.env.ADMIN_PATH_SECRET ?? "").replace(/^\/+|\/+$/g, "");
const ADMIN_BASE = ADMIN_PATH_SLUG ? `/${ADMIN_PATH_SLUG}` : "/admin";
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
// 기간 프리셋 → since ISO. "전체" 제거 — 미지정 기본은 최근 1년(집계 상한).
const YEAR_MS = 365 * 24 * 3600 * 1000;
function sinceFromPeriod(period: string | undefined): string {
  const now = Date.now();
  if (period === "24h") return new Date(now - 24 * 3600 * 1000).toISOString();
  if (period === "7d") return new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  if (period === "30d") return new Date(now - 30 * 24 * 3600 * 1000).toISOString();
  return new Date(now - YEAR_MS).toISOString();
}
function href(sp: SearchParams, patch: Record<string, string | undefined>): string {
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
    ps: first(sp.ps),
    log: first(sp.log),
    ...patch,
  };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
  const qs = params.toString();
  return qs ? `${ADMIN_BASE}?${qs}` : ADMIN_BASE;
}
function fmtDur(ms: number | null): string {
  if (ms == null) return "–";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
function fmtScore(v: number | null): string {
  return v == null ? "–" : v.toFixed(3);
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", { hour12: false });
}
function pctNum(n: number, total: number): number {
  return total ? (n / total) * 100 : 0;
}
function pct(n: number, total: number): string {
  return `${Math.round(pctNum(n, total))}%`;
}
// 큰 토큰·호출 수 압축 표기(1.2M / 34k). 사용량 스트립의 셀 폭에 맞춘다.
function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString();
}
function tint(color: string, amount = 14): string {
  return `color-mix(in oklch, ${color} ${amount}%, transparent)`;
}

// ── 페이지 ──────────────────────────────────────────────────────────────────
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const period = first(sp.period);
  const routeParam = first(sp.route);
  const route =
    routeParam === "unified" ||
    routeParam === "regulation" ||
    routeParam === "law" ||
    routeParam === "out_of_scope"
      ? routeParam
      : undefined;
  const hallucinationOnly = first(sp.halluc) === "1";
  const ip = first(sp.ip);
  const selectedId = first(sp.log) ? Number(first(sp.log)) : undefined;

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

  // 커스텀 날짜가 있으면 프리셋보다 우선하되 하한은 1년 전(집계 상한). to 는 그날 끝까지.
  const oneYearAgoIso = new Date(Date.now() - YEAR_MS).toISOString();
  const fromIso = from ? `${from}T00:00:00` : undefined;
  const fromClamped =
    fromIso != null && new Date(fromIso).getTime() < Date.now() - YEAR_MS;
  const since = fromIso == null ? sinceFromPeriod(period) : fromClamped ? oneYearAgoIso : fromIso;
  const until = to ? `${to}T23:59:59` : undefined;

  // 페이지당 건수 — 필터 행 콤보(?ps=)로 관리. 허용 목록 밖 값은 기본 10.
  const psParam = Number(first(sp.ps));
  const pageSize = [10, 20, 50, 100, 200, 300].includes(psParam) ? psParam : 10;

  const filter: QueryLogFilter = {
    limit: pageSize,
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

  const [stats, rows, detail] = await Promise.all([
    queryLogStats(filter),
    listQueryLogs(filter),
    selectedId != null && Number.isFinite(selectedId)
      ? getQueryLog(selectedId)
      : Promise.resolve(null),
  ]);

  // 로그 표 "시간대" 배지(주말/휴일/심야)용 공휴일 날짜키. 현재 연도 ±1 + 초기 행의
  // 연도를 커버(페이징으로 더 불러오는 행도 대부분 이 범위). KST 연도 기준.
  const nowKstYear = new Date(Date.now() + 9 * 3600 * 1000).getUTCFullYear();
  const holidayYears = new Set<number>([nowKstYear - 1, nowKstYear, nowKstYear + 1]);
  for (const r of rows) {
    holidayYears.add(new Date(new Date(r.created_at).getTime() + 9 * 3600 * 1000).getUTCFullYear());
  }
  const holidayMap = await getKoreanHolidaysForYears([...holidayYears]);
  const holidayKeys = [...holidayMap.values()].flatMap((s) => [...s]);

  const periods: Array<[string, string | undefined]> = [
    ["24시간", "24h"],
    ["7일", "7d"],
    ["30일", "30d"],
    ["1년", undefined], // 미지정 기본 = 1년(구 "전체" 링크도 자연 강등)
  ];
  // 분기 칩 — 2026-07 통합 개편 후 신규 행은 통합/범위밖만 쌓이므로 레거시(규정·법령)
  // 칩은 제외. 레거시 행은 URL ?route=regulation|law 로는 여전히 필터 가능.
  const routeChips: Array<[string, string | undefined]> = [
    ["전체", undefined],
    ["통합", "unified"],
    ["범위밖", "out_of_scope"],
  ];
  const periodLabel =
    period === "24h" ? "최근 24시간" : period === "7d" ? "최근 7일" : period === "30d" ? "최근 30일" : "최근 1년";
  // 도넛 데이터(미분류 포함 → 합 = total). 색은 charts.tsx routeConfig 가 소유.
  const donutData = [
    { route: "unified" as const, count: stats.byRoute.unified },
    { route: "regulation" as const, count: stats.byRoute.regulation },
    { route: "law" as const, count: stats.byRoute.law },
    { route: "out_of_scope" as const, count: stats.byRoute.out_of_scope },
    { route: "unknown" as const, count: stats.byRoute.unknown },
  ];

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-6 py-6">
        {/* 헤더 */}
        <header className="flex items-baseline justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <span
              className="text-lg font-bold tracking-tight text-primary"
              style={{ fontFamily: "var(--font-display)" }}
            >
              PIMS
            </span>
            <h1 className="text-sm font-medium text-muted-foreground">쿼리로그 대시보드</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground/70">읽기 전용 · service_role 서버 조회</span>
            <LogoutButton />
          </div>
        </header>

        {/* 계기판: 사용량·이용자·이용률 + 분기 도넛 + 추이 차트 + 품질 스트립.
            단일 카드 — 지표(좌)와 분기 도넛(우)을 한 행에 놓고 추이 차트는 하단 전폭.
            (구 2컬럼 그리드는 우측 도넛 카드에 세로 여백이 크게 남아 통합.) */}
        <section className="mt-4 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  사용량 추이
                </div>
                <div className="flex gap-1 text-[13px]">
                  {periods.map(([label, value]) => {
                    const on = period === value || (!period && !value);
                    return (
                      <Link
                        key={label}
                        href={href(sp, { period: value, log: undefined })}
                        className={`rounded-md px-2.5 py-1 transition ${
                          on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        {label}
                      </Link>
                    );
                  })}
                </div>
              </div>

              {/* 집계 범위 안내: 커스텀 from 이 1년 이전이면 클램프, 안전핀 도달 시 잘림 배지. */}
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

            {/* 상단: 지표 5종(좌) + 분기 분포 도넛(우). 사용 패턴 2종은 상담 부재 시간대
                (쉬는 날·평일 저녁심야) 이용 비중 — 자동화 서비스의 가치 지표. 두 버킷은
                교집합 없음(쉬는 날은 하루 전체). KST 기준(query_log 는 UTC 저장). */}
            {/* 좌(지표 5칸):우(분기 분포) = 6:4. 지표는 세로 구분선으로 칸을 구조화해
                (하단 KPI 스트립과 동일 문법) 빈 공간이 여백으로 남지 않게 하고, 도넛
                블록과 세로 중앙 정렬로 상하 여백을 줄인다. */}
            <div className="mt-4 grid gap-6 lg:grid-cols-[6fr_4fr] lg:items-center">
              <div className="grid min-w-0 grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 lg:gap-0 lg:divide-x lg:divide-border">
                <div className="lg:pr-4">
                  <HeroStat label="사용량" value={stats.total.toLocaleString()} sub={periodLabel} accent />
                </div>
                <div className="lg:px-4">
                  <HeroStat label="이용자 수" value={stats.distinctUsers.toLocaleString()} sub="고유 IP" />
                </div>
                <div className="lg:px-4">
                  <HeroStat
                    label="이용률"
                    value={stats.avgPerUser == null ? "–" : stats.avgPerUser.toFixed(1)}
                    sub="평균 질문/인"
                  />
                </div>
                <div className="lg:px-4">
                  <PatternStat
                    label="쉬는 날 사용"
                    count={stats.restDayCount}
                    total={stats.total}
                    note="주말·공휴일 · KST"
                  />
                </div>
                <div className="lg:pl-4">
                  <PatternStat
                    label="평일 저녁·심야 사용"
                    count={stats.weeknightCount}
                    total={stats.total}
                    note="18시~익일 6시 · KST"
                  />
                </div>
              </div>

              {/* 분기 분포 (도넛 120px + 범례) */}
              <div className="min-w-0 lg:border-l lg:border-border lg:pl-6">
                <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  분기 분포
                </div>
                <div className="mt-3 flex items-center gap-5">
                  <RouteDonut data={donutData} total={stats.total} />
                  {/* 범례 — 도넛 옆 보조 정보라 한 단계 작은 폰트로 밀도 유지 */}
                  <div className="flex flex-col gap-1.5 text-[11.5px]">
                    {[
                      { label: ROUTE_META.unified.label, color: ROUTE_META.unified.color, count: stats.byRoute.unified },
                      { label: ROUTE_META.regulation.label, color: ROUTE_META.regulation.color, count: stats.byRoute.regulation },
                      { label: ROUTE_META.law.label, color: ROUTE_META.law.color, count: stats.byRoute.law },
                      { label: ROUTE_META.out_of_scope.label, color: ROUTE_META.out_of_scope.color, count: stats.byRoute.out_of_scope },
                      ...(stats.byRoute.unknown > 0
                        ? [{ label: UNKNOWN_META.label, color: UNKNOWN_META.color, count: stats.byRoute.unknown }]
                        : []),
                    ].map((c) => (
                      <div key={c.label} className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-sm"
                          style={{ background: c.color }}
                        />
                        <span className="w-10 text-muted-foreground">{c.label}</span>
                        <span className="font-mono tabular-nums text-foreground">
                          {pct(c.count, stats.total)}
                        </span>
                        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground/70">
                          ({c.count.toLocaleString()}건)
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* 하단: 일별 추이(좌 50%) + 요일×시간 히트맵(우 50%). 히트맵은 일별 추이가
                못 보여주는 시간대 패턴(쉬는 날·심야 지표의 근거)을 드러낸다. KST. */}
            <div className="mt-4 grid gap-6 border-t border-border pt-4 lg:grid-cols-2">
              <div className="min-w-0">
                <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  일별 추이
                </div>
                <UsageChart data={stats.series} />
              </div>
              <div className="min-w-0 lg:border-l lg:border-border lg:pl-6">
                <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  요일 × 시간 히트맵 · KST
                </div>
                <UsageHeatmap data={stats.heatmap} />
              </div>
            </div>
          </div>

          {/* 품질 스트립: 평균 응답시간 → 환각률(인용 검증 내역 병기) → 오류율 → 만족도.
              인용 검증률은 환각률과 동일한 검증 결과의 인용 단위 표현이라 별도 칸 없이
              환각률 비고로 통합(ambiguous 는 검증 수에서만 빠지고 환각으론 안 침). */}
          <div className="grid grid-cols-2 border-t border-border bg-muted/40 sm:grid-cols-4">
            <Kpi label="평균 응답시간" value={fmtDur(stats.avgTotalMs)} note={`첫토큰 ${fmtDur(stats.avgTtftMs)}`} />
            <Kpi
              label="환각률"
              value={pct(stats.hallucinationCount, stats.total)}
              note={`${stats.hallucinationCount.toLocaleString()}건 · 인용 ${stats.citationCount.toLocaleString()}건 중 ${stats.citationVerifiedCount.toLocaleString()} 검증`}
              critical={stats.hallucinationCount > 0}
              status={stats.hallucinationCount > 0 ? "warn" : "ok"}
            />
            <Kpi
              label="오류율"
              value={pct(stats.errorCount, stats.total)}
              note={`${stats.errorCount.toLocaleString()}건`}
              critical={stats.errorCount > 0}
              status={stats.errorCount > 0 ? "warn" : "ok"}
            />
            <Kpi
              label="만족도"
              value={stats.ratedCount ? pct(stats.positiveCount, stats.ratedCount) : "–"}
              note={`긍정 ${stats.positiveCount.toLocaleString()}/${stats.ratedCount.toLocaleString()}`}
            />
          </div>

          {/* API 사용량 스트립: 제공자 기준 4칸(비중 순: Claude 답변·보조 → 법제처 → Cohere
              재정렬 → OpenAI 임베딩). 청구서 단위와 1:1 로 맞춰 비용 추적이 직관적이도록.
              Claude 는 tokens_in/out(답변)+api_usage(보조) 합, 나머지는 api_usage jsonb
              (계측 도입 후 행만). */}
          <div className="grid grid-cols-2 border-t border-border bg-muted/40 sm:grid-cols-4">
            <Kpi
              label="Claude API"
              value={`${fmtCount(
                stats.api.answerIn + stats.api.answerOut + stats.api.auxIn + stats.api.auxOut,
              )} 토큰`}
              note={`답변 ${fmtCount(stats.api.answerIn + stats.api.answerOut)} · 보조 ${fmtCount(
                stats.api.auxIn + stats.api.auxOut,
              )}`}
            />
            <Kpi
              label="법제처 API"
              value={`${fmtCount(stats.api.lawCalls)}회`}
              note="법령 조회 · DRF"
            />
            <Kpi
              label="Cohere API"
              value={`${fmtCount(stats.api.cohereUnits)} unit`}
              note={`재정렬 · ${stats.api.cohereCalls.toLocaleString()}회`}
            />
            <Kpi
              label="OpenAI API"
              value={`${fmtCount(stats.api.embedTokens)} 토큰`}
              note={`임베딩 · ${stats.api.embedCalls.toLocaleString()}회`}
            />
          </div>
        </section>

        {/* 필터 행 — 요소별 아웃라인 그룹(shadcn outline: border+rounded-lg+shadow-xs)을
            1열로 촘촘히(gap-2) 배열. 그룹: ①검색·기간 ②분기 세그먼트 ③품질 토글
            ④페이지당 콤보 (+조건부 IP 칩). 세그먼트 내부는 divide-x 로 등간격. */}
        <section className="mt-6 flex flex-wrap items-stretch gap-2 text-[13px]">
          {/* ① 검색·기간 */}
          <form
            method="get"
            action={ADMIN_BASE}
            className="flex items-stretch divide-x divide-border overflow-hidden rounded-lg border border-border bg-card shadow-xs"
          >
            {period && <input type="hidden" name="period" value={period} />}
            {route && <input type="hidden" name="route" value={route} />}
            {hallucinationOnly && <input type="hidden" name="halluc" value="1" />}
            {negativeOnly && <input type="hidden" name="neg" value="1" />}
            {ip && <input type="hidden" name="ip" value={ip} />}
            {sort && <input type="hidden" name="sort" value={sort} />}
            {sortDir && <input type="hidden" name="dir" value={sortDir} />}
            {pageSize !== 10 && <input type="hidden" name="ps" value={pageSize} />}
            <input
              type="search"
              name="q"
              defaultValue={search ?? ""}
              placeholder="질문·답변 검색"
              className="w-52 bg-transparent px-3 py-1.5 outline-none placeholder:text-muted-foreground/70"
            />
            <input
              type="date"
              name="from"
              defaultValue={from ?? ""}
              className="bg-transparent px-2.5 py-1.5 text-muted-foreground outline-none"
            />
            <input
              type="date"
              name="to"
              defaultValue={to ?? ""}
              className="bg-transparent px-2.5 py-1.5 text-muted-foreground outline-none"
            />
            <button
              type="submit"
              className="bg-primary px-3 py-1.5 font-medium text-primary-foreground transition hover:opacity-90"
            >
              조회
            </button>
          </form>

          {/* ② 분기 세그먼트 — 등간격(px-3 통일) */}
          <div className="flex items-stretch divide-x divide-border overflow-hidden rounded-lg border border-border bg-card shadow-xs">
            {routeChips.map(([label, value]) => {
              const on = route === value || (!route && !value);
              return (
                <Link
                  key={label}
                  href={href(sp, { route: value, log: undefined })}
                  className={`flex items-center px-3 py-1.5 transition ${
                    on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </div>

          {/* ③ 품질 토글 — 분기 세그먼트와 동일 등간격 */}
          <div className="flex items-stretch divide-x divide-border overflow-hidden rounded-lg border border-border bg-card shadow-xs">
            <Link
              href={href(sp, { halluc: hallucinationOnly ? undefined : "1", log: undefined })}
              className={`flex items-center px-3 py-1.5 transition ${
                hallucinationOnly
                  ? "bg-destructive text-destructive-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              환각만
            </Link>
            <Link
              href={href(sp, { neg: negativeOnly ? undefined : "1", log: undefined })}
              className={`flex items-center px-3 py-1.5 transition ${
                negativeOnly
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              부정만
            </Link>
          </div>

          {/* ④ 페이지당 콤보 */}
          <div className="flex items-center overflow-hidden rounded-lg border border-border bg-card shadow-xs">
            <span className="border-r border-border px-2.5 py-1.5 text-xs text-muted-foreground/70">
              페이지당
            </span>
            <PageSizeSelect
              value={pageSize}
              base={ADMIN_BASE}
              query={{
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
            />
          </div>

          {ip && (
            <Link
              href={href(sp, { ip: undefined, log: undefined })}
              className="flex items-center rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-muted-foreground shadow-xs transition hover:bg-muted"
            >
              IP={ip} ✕
            </Link>
          )}
        </section>

        {/* 상세 */}
        {detail && <DetailPanel sp={sp} detail={detail} />}

        {/* 로그 표 — 초기 한 페이지(ps 크기)는 서버 렌더, 페이지 이동은 SPA 페치 */}
        <LogTable
          key={[period, route, hallucinationOnly, negativeOnly, ip, search, from, to, sort, sortDir, pageSize]
            .map((v) => v ?? "")
            .join("|")}
          initialRows={rows}
          total={stats.total}
          holidays={holidayKeys}
          pageSize={pageSize}
          sp={{
            base: ADMIN_BASE,
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
            ps: pageSize !== 10 ? String(pageSize) : undefined,
          }}
          since={filter.since}
          until={filter.until}
          selectedId={selectedId}
        />
      </div>
    </main>
  );
}

// ── 서브 컴포넌트 ────────────────────────────────────────────────────────────
function HeroStat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={`mt-1.5 font-serif text-[2.15rem] leading-none tabular-nums ${
          accent ? "text-primary" : "text-foreground"
        }`}
      >
        {value}
      </div>
      <div className="mt-1.5 text-[11px] text-muted-foreground/80">{sub}</div>
    </div>
  );
}

// 사용 패턴 타일 — 히어로와 동일한 리듬(라벨/큰 숫자/보조)에 비율만 숫자 옆에 병기.
// 미터바 없음: 5칸 한 줄에서 히어로 타일과 시선 높이를 맞춘다.
function PatternStat({
  label,
  count,
  total,
  note,
}: {
  label: string;
  count: number;
  total: number;
  note: string;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="font-serif text-[2.15rem] leading-none tabular-nums text-foreground">
          {count.toLocaleString()}
        </span>
        <span className="text-[13px] tabular-nums text-muted-foreground">
          {pct(count, total)}
        </span>
      </div>
      <div className="mt-1.5 text-[11px] text-muted-foreground/80">{note}</div>
    </div>
  );
}


// 요일×시간 히트맵 — 순수 서버 렌더(클라이언트 JS 불필요). 단일 색상(primary) 순차
// 스케일: 0건은 중성 연회색, 최댓값으로 정규화해 진하게. 셀 title 로 hover 상세.
const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
function UsageHeatmap({ data }: { data: number[][] }) {
  const max = Math.max(1, ...data.flat());
  return (
    <div className="mt-4">
      <div className="flex flex-col gap-[3px]">
        {data.map((row, d) => (
          <div key={d} className="flex items-center gap-[3px]">
            <span className="w-4 shrink-0 text-[9px] leading-none text-muted-foreground/70">
              {DAY_LABELS[d]}
            </span>
            {row.map((c, h) => (
              <div
                key={h}
                title={`${DAY_LABELS[d]} ${h}시 · ${c.toLocaleString()}건`}
                className="h-3.5 min-w-0 flex-1 rounded-[3px]"
                style={{
                  background:
                    c === 0
                      ? "color-mix(in oklch, var(--muted-foreground) 8%, transparent)"
                      : `color-mix(in oklch, var(--primary) ${Math.round(15 + 85 * (c / max))}%, transparent)`,
                }}
              />
            ))}
          </div>
        ))}
        {/* 시간 눈금 — 셀 행과 동일 구조(요일 폭 스페이서 + 24슬롯)라 셀 시작점에 정확히 정렬. */}
        <div className="flex items-center gap-[3px]">
          <span className="w-4 shrink-0" />
          {Array.from({ length: 24 }, (_, h) => (
            <span
              key={h}
              className="min-w-0 flex-1 whitespace-nowrap text-[9px] leading-none text-muted-foreground/70"
            >
              {h % 6 === 0 ? `${h}시` : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  note,
  critical,
  status,
}: {
  label: string;
  value: string;
  note?: string;
  critical?: boolean;
  // 상태점: 정상/주의를 색점으로 표시(미터바 대체 — 환각·오류처럼 평시 0% 근처인 지표는
  // 바가 항상 비어 보여 시각 요소만 차지하므로 점이 더 읽기 쉽다).
  status?: "ok" | "warn";
}) {
  return (
    <div className="border-border px-4 py-3.5 sm:border-l sm:first:border-l-0">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        {status && (
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: status === "warn" ? "var(--destructive)" : "oklch(0.62 0.12 155)" }}
          />
        )}
      </div>
      {/* 값+비고 한 줄(2줄 표기): 큰 숫자 옆에 비고를 베이스라인 정렬로 병기. */}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span
          className={`font-serif text-2xl tabular-nums ${critical ? "text-destructive" : "text-foreground"}`}
        >
          {value}
        </span>
        {note && (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">{note}</span>
        )}
      </div>
    </div>
  );
}

function RoutePill({ route }: { route: "unified" | "regulation" | "law" | "out_of_scope" }) {
  const m = ROUTE_META[route];
  return (
    <span
      className="inline-block rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold"
      style={{ color: m.color, background: tint(m.color) }}
    >
      {m.label}
    </span>
  );
}

// 상세 메타 한 항목 — 라벨·값을 한 줄 칩으로(상단 압축 스트립용).
function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/80">
        {label}
      </span>
      <span className="text-[12.5px] tabular-nums text-foreground">{children}</span>
    </span>
  );
}

function Json({ value }: { value: unknown }) {
  if (value == null) return <span className="text-muted-foreground/50">–</span>;
  return (
    <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-border bg-muted/60 p-2.5 font-mono text-[11.5px] leading-relaxed text-foreground/80">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function DetailPanel({
  sp,
  detail,
}: {
  sp: SearchParams;
  detail: NonNullable<Awaited<ReturnType<typeof getQueryLog>>>;
}) {
  return (
    <section className="mt-6 rounded-xl border border-border bg-accent/60 p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-mono text-sm font-semibold text-foreground">
          #{detail.id}
          <span className="ml-2 font-sans font-normal text-muted-foreground">{fmtTime(detail.created_at)}</span>
        </h2>
        <Link href={href(sp, { log: undefined })} className="text-sm text-muted-foreground transition hover:text-foreground">
          닫기 ✕
        </Link>
      </div>

      {/* 메타 스트립 — 헤더 바로 아래 칩형 한두 줄로 압축(구 2×4 그리드 대체).
          질의·응답 본문이 패널의 주인공이 되도록 메타는 상단에 붙인다. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border/60 pb-4">
        <MetaItem label="IP">
          <span className="font-mono text-[12px]">{detail.ip ?? "–"}</span>
        </MetaItem>
        <MetaItem label="분기">{detail.route ? <RoutePill route={detail.route} /> : "–"}</MetaItem>
        <MetaItem label="관련도">{fmtScore(detail.top_score)}</MetaItem>
        <MetaItem label="환각">
          {detail.has_hallucination ? <span className="font-semibold text-destructive">예</span> : "아니오"}
        </MetaItem>
        <MetaItem label="모델">{detail.llm_model ?? "–"}</MetaItem>
        <MetaItem label="인용">
          {(detail.citation_verified_count ?? 0)}/{detail.citation_count ?? 0} 검증
        </MetaItem>
        <MetaItem label="지연 검색·재정렬·LLM">
          {fmtDur(detail.retrieval_ms)} · {fmtDur(detail.rerank_ms)} · {fmtDur(detail.llm_ms)}
        </MetaItem>
        <MetaItem label="첫토큰·총">
          {fmtDur(detail.ttft_ms)} · {fmtDur(detail.total_ms)}
        </MetaItem>
        <MetaItem label="토큰 in/out">
          {(detail.tokens_in ?? 0).toLocaleString()}/{(detail.tokens_out ?? 0).toLocaleString()}
        </MetaItem>
        <MetaItem label="게이트">
          {detail.gate_sufficient == null ? "–" : detail.gate_sufficient ? "충족" : "미충족"}
        </MetaItem>
        <MetaItem label="피드백">
          {detail.feedback === 1 ? (
            <span className="font-semibold text-primary">도움됨</span>
          ) : detail.feedback === -1 ? (
            <span className="font-semibold text-destructive">아쉬움</span>
          ) : (
            "–"
          )}
        </MetaItem>
        {detail.error_code && (
          <MetaItem label="오류">
            <span className="font-mono text-destructive">{detail.error_code}</span>
          </MetaItem>
        )}
      </div>

      <div className="mt-4 space-y-4">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">질문</div>
          <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground">{detail.query}</p>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">답변</div>
          {/* 답변은 LLM 마크다운 원문 — 챗 UI 와 동일한 Response(Streamdown) 뷰어로 렌더.
              질문은 사용자 평문이라 pre-wrap 유지(마크다운 해석 시 줄바꿈이 뭉개짐). */}
          {detail.answer ? (
            <div className="mt-1 text-[13.5px] leading-relaxed text-foreground/90">
              <Response>{detail.answer}</Response>
            </div>
          ) : (
            <p className="mt-1 text-[13.5px] text-muted-foreground">–</p>
          )}
        </div>
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
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            인용 검증 (cited_law_refs)
          </div>
          <Json value={detail.cited_law_refs} />
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            법령 참조 (law_refs)
          </div>
          <Json value={detail.law_refs} />
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            의도 분해 (intents)
          </div>
          <Json value={detail.intents} />
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            근거 문서 (retrieved)
          </div>
          <Json value={detail.retrieved} />
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            문서 id (retrieved_doc_ids)
          </div>
          <Json value={detail.retrieved_doc_ids} />
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            API 사용량 (api_usage)
          </div>
          <Json value={detail.api_usage} />
        </div>
      </div>
    </section>
  );
}
