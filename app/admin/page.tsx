import Link from "next/link";
import {
  listQueryLogs,
  queryLogStats,
  getQueryLog,
  type QueryLogFilter,
} from "@/lib/db/query-log";

// 관리자 대시보드(쿼리로그 뷰어). 미들웨어(/admin 게이트)가 서명 쿠키를 통과시킨
// 요청만 도달한다. 데이터는 전부 서버에서 service_role 로만 읽으므로 그 키가
// 브라우저로 나가지 않는다. 필터는 GET 쿼리 파라미터로 처리(클라이언트 JS 불필요).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SearchParams = { [key: string]: string | string[] | undefined };

const ROUTE_LABEL: Record<string, string> = {
  regulation: "규정",
  law: "법령",
  out_of_scope: "범위밖",
};

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function sinceFromPeriod(period: string | undefined): string | undefined {
  const now = Date.now();
  if (period === "24h") return new Date(now - 24 * 3600 * 1000).toISOString();
  if (period === "7d") return new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  return undefined; // 전체
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

function fmtMs(v: number | null): string {
  return v == null ? "–" : `${v.toLocaleString()}ms`;
}

function fmtScore(v: number | null): string {
  return v == null ? "–" : v.toFixed(3);
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", { hour12: false });
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-neutral-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-neutral-400">{sub}</div>}
    </div>
  );
}

function pct(n: number, total: number): string {
  return total ? `${Math.round((n / total) * 100)}%` : "0%";
}

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
  const routes: Array<[string, string | undefined]> = [
    ["전체", undefined],
    ["규정", "regulation"],
    ["법령", "law"],
    ["범위밖", "out_of_scope"],
  ];

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold text-neutral-900">쿼리로그 대시보드</h1>
        <span className="text-xs text-neutral-400">읽기 전용 · service_role 서버 조회</span>
      </header>

      {/* 요약 */}
      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Card label="질의 수" value={stats.total.toLocaleString()} sub={period ? `기간: ${period}` : "전체 기간"} />
        <Card
          label="분기 비율"
          value={`${pct(stats.byRoute.regulation, stats.total)} / ${pct(stats.byRoute.law, stats.total)} / ${pct(stats.byRoute.out_of_scope, stats.total)}`}
          sub="규정 / 법령 / 범위밖"
        />
        <Card label="환각 발생" value={stats.hallucinationCount.toLocaleString()} sub="has_hallucination" />
        <Card label="평균 응답" value={fmtMs(stats.avgTotalMs)} sub="total_ms" />
        <Card label="평균 첫토큰" value={fmtMs(stats.avgTtftMs)} sub="ttft_ms" />
        <Card
          label="토큰 합계"
          value={(stats.tokensIn + stats.tokensOut).toLocaleString()}
          sub={`in ${stats.tokensIn.toLocaleString()} · out ${stats.tokensOut.toLocaleString()}`}
        />
      </section>

      {/* 필터 */}
      <section className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div className="flex items-center gap-1">
          <span className="mr-1 text-neutral-400">기간</span>
          {periods.map(([label, value]) => (
            <Link
              key={label}
              href={href(sp, { period: value, log: undefined })}
              className={`rounded px-2 py-1 ${period === value || (!period && !value) ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"}`}
            >
              {label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-neutral-400">분기</span>
          {routes.map(([label, value]) => (
            <Link
              key={label}
              href={href(sp, { route: value, log: undefined })}
              className={`rounded px-2 py-1 ${route === value || (!route && !value) ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"}`}
            >
              {label}
            </Link>
          ))}
        </div>
        <Link
          href={href(sp, { halluc: hallucinationOnly ? undefined : "1", log: undefined })}
          className={`rounded px-2 py-1 ${hallucinationOnly ? "bg-red-600 text-white" : "text-neutral-600 hover:bg-neutral-100"}`}
        >
          환각만
        </Link>
        {ip && (
          <Link href={href(sp, { ip: undefined, log: undefined })} className="rounded px-2 py-1 text-neutral-600 hover:bg-neutral-100">
            IP={ip} ✕
          </Link>
        )}
      </section>

      {/* 상세 */}
      {detail && <DetailPanel sp={sp} detail={detail} />}

      {/* 로그 표 */}
      <section className="mt-6 overflow-x-auto rounded-lg border border-neutral-200">
        <table className="w-full min-w-[880px] text-left text-sm">
          <thead className="bg-neutral-50 text-xs text-neutral-500">
            <tr>
              <th className="px-3 py-2 font-medium">시각</th>
              <th className="px-3 py-2 font-medium">IP</th>
              <th className="px-3 py-2 font-medium">질문</th>
              <th className="px-3 py-2 font-medium">분기</th>
              <th className="px-3 py-2 font-medium">관련도</th>
              <th className="px-3 py-2 font-medium">환각</th>
              <th className="px-3 py-2 font-medium">응답</th>
              <th className="px-3 py-2 font-medium">토큰</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-neutral-400">
                  조건에 맞는 로그가 없습니다.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.id}
                className={`hover:bg-neutral-50 ${selectedId === r.id ? "bg-neutral-50" : ""}`}
              >
                <td className="whitespace-nowrap px-3 py-2 text-neutral-500">{fmtTime(r.created_at)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-neutral-500">
                  {r.ip ? (
                    <Link href={href(sp, { ip: r.ip, log: undefined })} className="hover:underline">
                      {r.ip}
                    </Link>
                  ) : (
                    "–"
                  )}
                </td>
                <td className="max-w-md px-3 py-2">
                  <Link href={href(sp, { log: String(r.id) })} className="block truncate text-neutral-800 hover:underline">
                    {r.query}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-neutral-600">
                  {r.route ? ROUTE_LABEL[r.route] : "–"}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-neutral-600">{fmtScore(r.top_score)}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  {r.has_hallucination ? <span className="text-red-600">●</span> : <span className="text-neutral-300">○</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-neutral-600">{fmtMs(r.total_ms)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-neutral-500">
                  {((r.tokens_in ?? 0) + (r.tokens_out ?? 0)).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="mt-3 text-xs text-neutral-400">최근 {rows.length}건 표시(최대 100).</p>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-neutral-500">{label}</div>
      <div className="mt-0.5 text-sm text-neutral-800">{children}</div>
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  if (value == null) return <span className="text-neutral-400">–</span>;
  return (
    <pre className="mt-1 max-h-48 overflow-auto rounded bg-neutral-50 p-2 text-xs text-neutral-700">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

async function DetailPanel({
  sp,
  detail,
}: {
  sp: SearchParams;
  detail: NonNullable<Awaited<ReturnType<typeof getQueryLog>>>;
}) {
  return (
    <section className="mt-6 rounded-lg border border-neutral-300 bg-white p-5">
      <div className="flex items-start justify-between">
        <h2 className="text-sm font-semibold text-neutral-900">
          #{detail.id} 상세 · {fmtTime(detail.created_at)}
        </h2>
        <Link href={href(sp, { log: undefined })} className="text-sm text-neutral-500 hover:underline">
          닫기 ✕
        </Link>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Field label="IP">{detail.ip ?? "–"}</Field>
        <Field label="분기">{detail.route ? ROUTE_LABEL[detail.route] : "–"}</Field>
        <Field label="관련도(top_score)">{fmtScore(detail.top_score)}</Field>
        <Field label="환각">{detail.has_hallucination ? "예" : "아니오"}</Field>
        <Field label="모델">{detail.llm_model ?? "–"}</Field>
        <Field label="인용(검증/전체)">
          {(detail.citation_verified_count ?? 0)}/{(detail.citation_count ?? 0)}
        </Field>
        <Field label="지연(검색·재정렬·LLM)">
          {fmtMs(detail.retrieval_ms)} · {fmtMs(detail.rerank_ms)} · {fmtMs(detail.llm_ms)}
        </Field>
        <Field label="첫토큰 · 총">
          {fmtMs(detail.ttft_ms)} · {fmtMs(detail.total_ms)}
        </Field>
        <Field label="토큰(in/out)">
          {(detail.tokens_in ?? 0).toLocaleString()} / {(detail.tokens_out ?? 0).toLocaleString()}
        </Field>
        <Field label="게이트 충족">{detail.gate_sufficient == null ? "–" : detail.gate_sufficient ? "예" : "아니오"}</Field>
        {detail.error_code && <Field label="오류코드">{detail.error_code}</Field>}
      </div>

      <div className="mt-4 space-y-3">
        <Field label="질문">
          <p className="whitespace-pre-wrap">{detail.query}</p>
        </Field>
        <Field label="답변">
          <p className="whitespace-pre-wrap">{detail.answer ?? "–"}</p>
        </Field>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="text-xs font-medium text-neutral-500">인용 검증(cited_law_refs)</div>
          <Json value={detail.cited_law_refs} />
        </div>
        <div>
          <div className="text-xs font-medium text-neutral-500">법령 참조(law_refs)</div>
          <Json value={detail.law_refs} />
        </div>
        <div>
          <div className="text-xs font-medium text-neutral-500">근거 문서(retrieved)</div>
          <Json value={detail.retrieved} />
        </div>
        <div>
          <div className="text-xs font-medium text-neutral-500">문서 id(retrieved_doc_ids)</div>
          <Json value={detail.retrieved_doc_ids} />
        </div>
      </div>
    </section>
  );
}
