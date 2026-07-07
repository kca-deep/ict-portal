import Link from "next/link";
import {
  listQueryLogs,
  queryLogStats,
  getQueryLog,
  type QueryLogFilter,
  type QueryLogStats,
} from "@/lib/db/query-log";

// 관리자 대시보드(쿼리로그 뷰어). 미들웨어(/admin 게이트)가 서명 쿠키를 통과시킨
// 요청만 도달한다. 데이터는 전부 서버에서 service_role 로만 읽으므로 그 키가
// 브라우저로 나가지 않는다. 필터는 GET 쿼리 파라미터로 처리(클라이언트 JS 불필요).
// 테마: PIMS 웜 페이퍼 + 잉크블루 + 출처색(규정=블루 / 법령=앰버). globals.css 토큰 사용.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SearchParams = { [key: string]: string | string[] | undefined };

const ROUTE_META: Record<
  "regulation" | "law" | "out_of_scope",
  { label: string; color: string }
> = {
  regulation: { label: "규정", color: "var(--badge-regulation)" },
  law: { label: "법령", color: "var(--badge-law)" },
  out_of_scope: { label: "범위밖", color: "var(--muted-foreground)" },
};

// ── 포매터 ──────────────────────────────────────────────────────────────────
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
function sinceFromPeriod(period: string | undefined): string | undefined {
  const now = Date.now();
  if (period === "24h") return new Date(now - 24 * 3600 * 1000).toISOString();
  if (period === "7d") return new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  return undefined;
}
function href(sp: SearchParams, patch: Record<string, string | undefined>): string {
  const merged: Record<string, string | undefined> = {
    period: first(sp.period),
    route: first(sp.route),
    halluc: first(sp.halluc),
    ip: first(sp.ip),
    log: first(sp.log),
    ...patch,
  };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
  const qs = params.toString();
  return qs ? `/admin?${qs}` : "/admin";
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
    routeParam === "regulation" || routeParam === "law" || routeParam === "out_of_scope"
      ? routeParam
      : undefined;
  const hallucinationOnly = first(sp.halluc) === "1";
  const ip = first(sp.ip);
  const selectedId = first(sp.log) ? Number(first(sp.log)) : undefined;

  const filter: QueryLogFilter = {
    limit: 100,
    route,
    hallucinationOnly,
    ip,
    since: sinceFromPeriod(period),
  };

  const [stats, rows, detail] = await Promise.all([
    queryLogStats(filter),
    listQueryLogs(filter),
    selectedId != null && Number.isFinite(selectedId)
      ? getQueryLog(selectedId)
      : Promise.resolve(null),
  ]);

  const periods: Array<[string, string | undefined]> = [
    ["24시간", "24h"],
    ["7일", "7d"],
    ["전체", undefined],
  ];
  const routeChips: Array<[string, string | undefined]> = [
    ["전체", undefined],
    ["규정", "regulation"],
    ["법령", "law"],
    ["범위밖", "out_of_scope"],
  ];
  const periodLabel = period === "24h" ? "최근 24시간" : period === "7d" ? "최근 7일" : "전체 기간";

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-6 py-10">
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
          <span className="text-xs text-muted-foreground/70">읽기 전용 · service_role 서버 조회</span>
        </header>

        {/* 계기판: 사용량·이용자·이용률 + 추이 차트 + 분기 도넛 + 품질 스트립 */}
        <section className="mt-5 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="grid lg:grid-cols-[1.7fr_1fr]">
            {/* 좌: 사용량 지표 + 추이 차트 */}
            <div className="p-6 lg:border-r lg:border-border">
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

              <div className="mt-5 grid grid-cols-3 gap-4">
                <HeroStat label="사용량" value={stats.total.toLocaleString()} sub={periodLabel} accent />
                <HeroStat label="이용자 수" value={stats.distinctUsers.toLocaleString()} sub="고유 IP" />
                <HeroStat
                  label="이용률"
                  value={stats.avgPerUser == null ? "–" : stats.avgPerUser.toFixed(1)}
                  sub="평균 질문/인"
                />
              </div>

              <AreaChart series={stats.series} />
            </div>

            {/* 우: 분기 분포 도넛 */}
            <div className="flex flex-col p-6">
              <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                분기 분포
              </div>
              <div className="mt-4 flex flex-1 items-center gap-6">
                <Donut stats={stats} />
                <div className="flex flex-col gap-2.5 text-[13px]">
                  {(["regulation", "law", "out_of_scope"] as const).map((k) => (
                    <div key={k} className="flex items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-sm"
                        style={{ background: ROUTE_META[k].color }}
                      />
                      <span className="w-12 text-muted-foreground">{ROUTE_META[k].label}</span>
                      <span className="font-mono tabular-nums text-foreground">
                        {pct(stats.byRoute[k], stats.total)}
                      </span>
                      <span className="font-mono text-xs tabular-nums text-muted-foreground/70">
                        {stats.byRoute[k].toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 품질 스트립: 평균 응답시간 → 환각률 → 인용 검증률 → 오류율 */}
          <div className="grid grid-cols-2 border-t border-border bg-muted/40 sm:grid-cols-4">
            <Kpi label="평균 응답시간" value={fmtDur(stats.avgTotalMs)} note={`첫토큰 ${fmtDur(stats.avgTtftMs)}`} />
            <Kpi
              label="환각률"
              value={pct(stats.hallucinationCount, stats.total)}
              note={`${stats.hallucinationCount.toLocaleString()}건`}
              critical={stats.hallucinationCount > 0}
            />
            <Kpi
              label="인용 검증률"
              value={pct(stats.citationVerifiedCount, stats.citationCount)}
              note={`${stats.citationVerifiedCount.toLocaleString()}/${stats.citationCount.toLocaleString()}`}
            />
            <Kpi
              label="오류율"
              value={pct(stats.errorCount, stats.total)}
              note={`${stats.errorCount.toLocaleString()}건`}
              critical={stats.errorCount > 0}
            />
          </div>
        </section>

        {/* 필터 */}
        <section className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
          <div className="flex items-center gap-1">
            <span className="mr-1 text-xs text-muted-foreground/70">분기</span>
            {routeChips.map(([label, value]) => {
              const on = route === value || (!route && !value);
              return (
                <Link
                  key={label}
                  href={href(sp, { route: value, log: undefined })}
                  className={`rounded-md px-2.5 py-1 transition ${
                    on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </div>
          <Link
            href={href(sp, { halluc: hallucinationOnly ? undefined : "1", log: undefined })}
            className={`rounded-md px-2.5 py-1 transition ${
              hallucinationOnly
                ? "bg-destructive text-destructive-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            환각만
          </Link>
          {ip && (
            <Link
              href={href(sp, { ip: undefined, log: undefined })}
              className="rounded-md px-2.5 py-1 font-mono text-muted-foreground transition hover:bg-muted"
            >
              IP={ip} ✕
            </Link>
          )}
        </section>

        {/* 상세 */}
        {detail && <DetailPanel sp={sp} detail={detail} />}

        {/* 로그 표 */}
        <section className="mt-6 overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
          <table className="w-full min-w-[880px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">시각</th>
                <th className="px-4 py-2.5 text-left font-medium">IP</th>
                <th className="px-4 py-2.5 text-left font-medium">질문</th>
                <th className="px-4 py-2.5 text-left font-medium">분기</th>
                <th className="px-4 py-2.5 text-right font-medium">관련도</th>
                <th className="px-4 py-2.5 text-center font-medium">환각</th>
                <th className="px-4 py-2.5 text-right font-medium">응답</th>
                <th className="px-4 py-2.5 text-right font-medium">토큰</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-14 text-center text-muted-foreground">
                    조건에 맞는 로그가 없습니다.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b border-border/60 transition last:border-0 hover:bg-muted/50 ${
                    selectedId === r.id ? "bg-accent" : ""
                  }`}
                >
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs tabular-nums text-muted-foreground">
                    {fmtTime(r.created_at)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted-foreground">
                    {r.ip ? (
                      <Link href={href(sp, { ip: r.ip, log: undefined })} className="hover:text-primary hover:underline">
                        {r.ip}
                      </Link>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className="max-w-md px-4 py-2.5">
                    <Link
                      href={href(sp, { log: String(r.id) })}
                      className="block truncate text-foreground hover:text-primary hover:underline"
                    >
                      {r.query}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5">
                    {r.route ? <RoutePill route={r.route} /> : <span className="text-muted-foreground">–</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                    {fmtScore(r.top_score)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-center">
                    {r.has_hallucination ? (
                      <span
                        className="inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold text-destructive"
                        style={{ background: tint("var(--destructive)", 12) }}
                      >
                        환각
                      </span>
                    ) : (
                      <span className="text-muted-foreground/30">·</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                    {fmtDur(r.total_ms)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {((r.tokens_in ?? 0) + (r.tokens_out ?? 0)).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <p className="mt-3 text-xs text-muted-foreground/70">최근 {rows.length}건 표시(최대 100).</p>
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

// 사용량 추이 SVG 영역차트. 서버에서 path 를 직접 계산해 렌더(클라이언트 JS 없음).
// 폭은 100%로 늘리되(preserveAspectRatio=none) 선은 non-scaling-stroke 로 또렷하게.
function AreaChart({ series }: { series: { label: string; count: number }[] }) {
  const n = series.length;
  const W = 600;
  const H = 128;
  const pad = 8;
  const max = Math.max(1, ...series.map((s) => s.count));
  const x = (i: number) => (n <= 1 ? W / 2 : pad + (i / (n - 1)) * (W - pad * 2));
  const y = (c: number) => H - pad - (c / max) * (H - pad * 2);
  const line = series.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s.count).toFixed(1)}`).join(" ");
  const area =
    n === 0
      ? ""
      : `M${x(0).toFixed(1)},${H} ` +
        series.map((s, i) => `L${x(i).toFixed(1)},${y(s.count).toFixed(1)}`).join(" ") +
        ` L${x(n - 1).toFixed(1)},${H} Z`;
  const labels = n === 0 ? [] : [series[0], series[Math.floor((n - 1) / 2)], series[n - 1]];
  return (
    <div className="mt-5">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-28 w-full" role="img" aria-label="사용량 추이">
        <defs>
          <linearGradient id="usageFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.20" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {n > 0 && <path d={area} fill="url(#usageFill)" />}
        {n > 0 && (
          <path
            d={line}
            fill="none"
            stroke="var(--primary)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {labels.length > 0 && (
        <div className="mt-1.5 flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground/60">
          <span>{labels[0].label}</span>
          <span>{labels[1].label}</span>
          <span>{labels[2].label}</span>
        </div>
      )}
    </div>
  );
}

// 분기 분포 도넛(SVG). stroke-dasharray 로 세 분기를 그린다(출처색).
function Donut({ stats }: { stats: QueryLogStats }) {
  const size = 108;
  const c = size / 2;
  const r = 42;
  const sw = 13;
  const C = 2 * Math.PI * r;
  let acc = 0;
  const arcs = (["regulation", "law", "out_of_scope"] as const)
    .map((k) => {
      const frac = stats.total ? stats.byRoute[k] / stats.total : 0;
      const len = frac * C;
      const off = -acc;
      acc += len;
      return { k, len, off, color: ROUTE_META[k].color };
    })
    .filter((a) => a.len > 0);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" role="img" aria-label="분기 분포">
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--muted)" strokeWidth={sw} />
      <g transform={`rotate(-90 ${c} ${c})`}>
        {arcs.map((a) => (
          <circle
            key={a.k}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={a.color}
            strokeWidth={sw}
            strokeDasharray={`${a.len.toFixed(2)} ${(C - a.len).toFixed(2)}`}
            strokeDashoffset={a.off.toFixed(2)}
          />
        ))}
      </g>
      <text x={c} y={c - 1} textAnchor="middle" className="fill-foreground font-serif" style={{ fontSize: 22 }}>
        {stats.total.toLocaleString()}
      </text>
      <text x={c} y={c + 15} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 10 }}>
        질의
      </text>
    </svg>
  );
}

function Kpi({
  label,
  value,
  note,
  critical,
}: {
  label: string;
  value: string;
  note?: string;
  critical?: boolean;
}) {
  return (
    <div className="border-border px-4 py-3.5 sm:border-l sm:first:border-l-0">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={`mt-1 font-serif text-2xl tabular-nums ${critical ? "text-destructive" : "text-foreground"}`}
      >
        {value}
      </div>
      {note && <div className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground/70">{note}</div>}
    </div>
  );
}

function RoutePill({ route }: { route: "regulation" | "law" | "out_of_scope" }) {
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-[13.5px] tabular-nums text-foreground">{children}</div>
    </div>
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

      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Field label="IP">
          <span className="font-mono text-[13px]">{detail.ip ?? "–"}</span>
        </Field>
        <Field label="분기">{detail.route ? <RoutePill route={detail.route} /> : "–"}</Field>
        <Field label="관련도">{fmtScore(detail.top_score)}</Field>
        <Field label="환각">
          {detail.has_hallucination ? <span className="font-semibold text-destructive">예</span> : "아니오"}
        </Field>
        <Field label="모델">{detail.llm_model ?? "–"}</Field>
        <Field label="인용(검증/전체)">
          {(detail.citation_verified_count ?? 0)}/{detail.citation_count ?? 0}
        </Field>
        <Field label="지연(검색·재정렬·LLM)">
          {fmtDur(detail.retrieval_ms)} · {fmtDur(detail.rerank_ms)} · {fmtDur(detail.llm_ms)}
        </Field>
        <Field label="첫토큰 · 총">
          {fmtDur(detail.ttft_ms)} · {fmtDur(detail.total_ms)}
        </Field>
        <Field label="토큰(in/out)">
          {(detail.tokens_in ?? 0).toLocaleString()} / {(detail.tokens_out ?? 0).toLocaleString()}
        </Field>
        <Field label="게이트 충족">
          {detail.gate_sufficient == null ? "–" : detail.gate_sufficient ? "예" : "아니오"}
        </Field>
        {detail.error_code && (
          <Field label="오류코드">
            <span className="font-mono text-destructive">{detail.error_code}</span>
          </Field>
        )}
      </div>

      <div className="mt-5 space-y-4">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">질문</div>
          <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground">{detail.query}</p>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">답변</div>
          <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground/90">
            {detail.answer ?? "–"}
          </p>
        </div>
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
      </div>
    </section>
  );
}
