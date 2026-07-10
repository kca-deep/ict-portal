"use client";

import { useState } from "react";
import Link from "next/link";
import type { QueryLogListItem } from "@/lib/db/query-log";

// query_log 표(클라이언트). 초기 20건은 서버가 렌더해 넘기고, "더 조회하기"를 누르면
// /api/admin/logs 에서 다음 20건을 받아 하단에 이어붙인다(SPA, 전체 리로드 없음).
// 서버로 넘어오는 건 요약 행뿐 — service_role 은 서버에만 있다.

const PAGE = 10;

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

const ROUTE_META = {
  regulation: { label: "규정", color: "var(--badge-regulation)" },
  law: { label: "법령", color: "var(--badge-law)" },
  out_of_scope: { label: "범위밖", color: "var(--muted-foreground)" },
} as const;

function tint(color: string, amount = 14) {
  return `color-mix(in oklch, ${color} ${amount}%, transparent)`;
}
function fmtDur(ms: number | null) {
  return ms == null ? "–" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
function fmtScore(v: number | null) {
  return v == null ? "–" : v.toFixed(3);
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("ko-KR", { hour12: false });
}
function href(sp: Sp, patch: Record<string, string | undefined>) {
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
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
  const qs = p.toString();
  return qs ? `/admin?${qs}` : "/admin";
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
  const [rows, setRows] = useState<QueryLogListItem[]>(initialRows);
  const [hasMore, setHasMore] = useState(initialRows.length === PAGE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  async function loadMore() {
    if (loading) return;
    setLoading(true);
    setError(false);
    try {
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
      const res = await fetch(`/api/admin/logs?${p.toString()}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { rows: QueryLogListItem[] };
      setRows((prev) => [...prev, ...data.rows]);
      setHasMore(data.rows.length === PAGE);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <section className="mt-6 overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full min-w-[940px] border-collapse text-[13px]">
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
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-14 text-center text-muted-foreground">
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
                <td className="whitespace-nowrap px-4 py-2.5 text-center">
                  {r.feedback === 1 ? (
                    <span title="도움됨">👍</span>
                  ) : r.feedback === -1 ? (
                    <span title="아쉬움">👎</span>
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

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground/70">
          {rows.length.toLocaleString()}건 표시
          {error && <span className="ml-2 text-destructive">불러오기 실패 — 다시 시도하세요.</span>}
        </p>
        {hasMore && (
          <button
            onClick={loadMore}
            disabled={loading}
            className="rounded-md border border-border bg-card px-4 py-1.5 text-[13px] font-medium text-foreground shadow-sm transition hover:bg-muted disabled:opacity-50"
          >
            {loading ? "불러오는 중…" : "더보기"}
          </button>
        )}
      </div>
    </>
  );
}
