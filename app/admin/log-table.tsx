"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { QueryLogListItem } from "@/lib/db/query-log";

// query_log 표(클라이언트). 초기 한 페이지(기본 20건)는 서버가 렌더해 넘기고, 페이지 이동·
// 페이지 크기 변경 시 /api/admin/logs 에서 해당 구간을 offset/limit 로 받아 교체한다.
// service_role 은 서버에만 있으므로 넘어오는 건 요약 행뿐. total(필터 내 총건수)로 페이지 수 산출.

const PAGE_SIZES = [20, 50, 100, 200, 300] as const;
const DEFAULT_SIZE = 20;

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
  unified: { label: "통합", color: "oklch(0.55 0.11 170)" },
  regulation: { label: "규정", color: "var(--badge-regulation)" },
  law: { label: "법령", color: "var(--badge-law)" },
  out_of_scope: { label: "범위밖", color: "var(--muted-foreground)" },
} as const;

// 시간대 배지 — 성과지표(쉬는 날·평일 저녁·심야)와 같은 잣대. 주말/공휴일/평일심야 3종,
// 업무시간 내(평일 09~18시)는 배지 없이 하이픈. 색은 route·환각과 겹치지 않게 선택.
const DAY_KIND_META = {
  weekend: { label: "주말", color: "oklch(0.55 0.14 305)" },
  holiday: { label: "휴일", color: "oklch(0.58 0.16 350)" },
  night: { label: "심야", color: "oklch(0.52 0.07 262)" },
} as const;
type DayKind = keyof typeof DAY_KIND_META;

function tint(color: string, amount = 14) {
  return `color-mix(in oklch, ${color} ${amount}%, transparent)`;
}
function fmtDur(ms: number | null) {
  return ms == null ? "–" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// created_at(UTC 저장)을 KST(UTC+9)로 환산해 "YY-MM-DD. HH:MM"(24시간제)로 표기.
// +9h 후 getUTC* 를 읽어 서버(UTC)·클라이언트(KST) 어디서 렌더해도 동일 문자열 → 하이드레이션
// 불일치 없음.
function kstShift(iso: string) {
  return new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
}
function fmtTime(iso: string) {
  const d = kstShift(iso);
  const yy = String(d.getUTCFullYear()).slice(2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yy}-${mm}-${dd}. ${hh}:${mi}`;
}

// 시간대 분류(KST). 주말·공휴일 = 쉬는 날(하루 전체), 그 밖 평일 18~06시 = 심야.
// 평일 주간(비휴일 09~18, 06~09 포함)은 null → 하이픈. 성과지표 버킷과 동일 규칙.
function dayKindOf(iso: string, holidays: Set<string>): DayKind | null {
  const d = kstShift(iso);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  if (day === 0 || day === 6) return "weekend";
  if (holidays.has(key)) return "holiday";
  if (hour >= 18 || hour < 6) return "night";
  return null;
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
function DayKindPill({ kind }: { kind: DayKind }) {
  const m = DAY_KIND_META[kind];
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold"
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
  total,
  holidays,
  sp,
  since,
  until,
  selectedId,
}: {
  initialRows: QueryLogListItem[];
  total: number;
  holidays: string[];
  sp: Sp;
  since?: string;
  until?: string;
  selectedId?: number;
}) {
  const [rows, setRows] = useState<QueryLogListItem[]>(initialRows);
  const [page, setPage] = useState(0); // 0-indexed
  const [pageSize, setPageSize] = useState<number>(DEFAULT_SIZE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const holidaySet = useMemo(() => new Set(holidays), [holidays]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const offset = page * pageSize;

  // page/pageSize 변경 시에만 서버에서 해당 구간을 당겨온다. 첫 마운트(page 0·기본 크기)는
  // 서버가 준 initialRows 를 그대로 쓰므로 skip(불필요한 재조회 방지). 필터가 바뀌면 부모가
  // key 로 이 컴포넌트를 remount → 상태가 초기값으로 리셋된다.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(false);
      try {
        const p = new URLSearchParams();
        p.set("offset", String(page * pageSize));
        p.set("limit", String(pageSize));
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
        if (!cancelled) setRows(data.rows);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // sp/since/until 은 remount 로 고정이므로 deps 에서 제외(page·pageSize 만 관찰).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize]);

  function changeSize(n: number) {
    if (n === pageSize) return;
    setPageSize(n);
    setPage(0);
  }

  const rangeText =
    total === 0
      ? "0건"
      : `${(offset + 1).toLocaleString()}–${(offset + rows.length).toLocaleString()} / ${total.toLocaleString()}건`;

  const chip = (on: boolean) =>
    `rounded-md px-2.5 py-1 text-[13px] transition ${
      on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
    }`;
  const navBtn =
    "rounded-md border border-border bg-card px-2.5 py-1 text-[13px] text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";

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
              <th className="px-4 py-2.5 text-center font-medium">시간대</th>
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
                  {loading ? "불러오는 중…" : "조건에 맞는 로그가 없습니다."}
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const kind = dayKindOf(r.created_at, holidaySet);
              return (
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
                  <td className="whitespace-nowrap px-4 py-2.5 text-center">
                    {kind ? <DayKindPill kind={kind} /> : <span className="text-muted-foreground/40">–</span>}
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
              );
            })}
          </tbody>
        </table>
      </section>

      {/* 페이지네이션 — 좌: 페이지당 건수(20~300), 우: 범위·이전/다음. 필터 내 총건수(total)로
          페이지 수를 산출한다. */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-1">
        <div className="flex items-center gap-1">
          <span className="mr-1 text-xs text-muted-foreground/70">페이지당</span>
          {PAGE_SIZES.map((n) => (
            <button key={n} onClick={() => changeSize(n)} className={chip(pageSize === n)} disabled={loading}>
              {n}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs tabular-nums text-muted-foreground">
            {loading ? "불러오는 중…" : error ? "불러오기 실패" : rangeText}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={loading || page <= 0}
              className={navBtn}
            >
              ‹ 이전
            </button>
            <span className="px-2 text-xs tabular-nums text-muted-foreground">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={loading || page >= totalPages - 1}
              className={navBtn}
            >
              다음 ›
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
