"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { QueryLogDetail, QueryLogListItem } from "@/lib/db/query-log";
import { Response } from "@/components/ui/response";

// query_log 표(클라이언트). 초기 한 페이지는 서버가 렌더해 넘기고(크기는 ?ps= 콤보 —
// 필터 행의 PageSizeSelect 가 관리), 페이지 이동 시 /api/admin/logs 에서 해당 구간을
// offset/limit 로 받아 교체한다. service_role 은 서버에만 있으므로 넘어오는 건 요약 행뿐.
// 질문을 누르면 /api/admin/logs/{id} 에서 전문을 받아 팝업으로 연다(페이지 이동 없음 —
// 대시보드 재렌더·스크롤 점프 없이 표 상태·페이지를 그대로 유지).

type Sp = {
  base: string; // 관리자 링크 베이스 — "/admin" 또는 슬러그 모드의 "/{slug}"
  ps?: string; // 페이지당 건수(기본 10이면 생략) — 행 내 링크가 보존해야 함
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
    ps: sp.ps,
    ...patch,
  };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
  const qs = p.toString();
  return qs ? `${sp.base}?${qs}` : sp.base;
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
  w,
}: {
  sp: Sp;
  col: "created_at" | "top_score" | "total_ms" | "tokens";
  label: string;
  align: "left" | "right";
  w?: string; // table-fixed 칼럼 폭 클래스
}) {
  const active = sp.sort === col || (!sp.sort && col === "created_at");
  const dir = active ? (sp.dir === "asc" ? "asc" : "desc") : "desc";
  const nextDir = active && dir === "desc" ? "asc" : "desc";
  const arrow = active ? (dir === "desc" ? " ↓" : " ↑") : "";
  return (
    <th className={`px-4 py-2.5 font-medium ${align === "right" ? "text-right" : "text-left"} ${w ?? ""}`}>
      <Link
        href={href(sp, { sort: col, dir: nextDir })}
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
  pageSize,
  sp,
  since,
  until,
}: {
  initialRows: QueryLogListItem[];
  total: number;
  holidays: string[];
  pageSize: number; // 페이지당 건수 — 필터 행 콤보(?ps=)가 결정, 변경 시 부모 key 로 remount
  sp: Sp;
  since?: string;
  until?: string;
}) {
  const [rows, setRows] = useState<QueryLogListItem[]>(initialRows);
  const [page, setPage] = useState(0); // 0-indexed
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null); // 상세 팝업 대상
  const closeDetail = useCallback(() => setSelectedId(null), []);

  const holidaySet = useMemo(() => new Set(holidays), [holidays]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const offset = page * pageSize;

  // page 변경 시에만 서버에서 해당 구간을 당겨온다. 첫 마운트(page 0)는 서버가 준
  // initialRows 를 그대로 쓰므로 skip(불필요한 재조회 방지). 필터·페이지 크기가 바뀌면
  // 부모가 key 로 이 컴포넌트를 remount → 상태가 초기값으로 리셋된다.
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
    // sp/since/until/pageSize 는 remount 로 고정이므로 deps 에서 제외(page 만 관찰).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const rangeText =
    total === 0
      ? "0건"
      : `${(offset + 1).toLocaleString()}–${(offset + rows.length).toLocaleString()} / ${total.toLocaleString()}건`;

  const navBtn =
    "rounded-md border border-border bg-card px-2.5 py-1 text-[13px] text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <>
      {/* table-fixed + 명시 칼럼 폭: 고정 칼럼을 뺀 남는 폭을 질문이 전부 받아 말줄임(…)
          처리되므로 카드에 가로 스크롤이 생기지 않는다(overflow-x-auto 는 초소형 화면 안전핀).
          페이지당 건수 콤보는 상단 필터 행(PageSizeSelect)으로 이동. */}
      <section className="mt-6 overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full table-fixed border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
              <SortTh sp={sp} col="created_at" label="시각" align="left" w="w-[128px]" />
              <th className="w-[118px] px-4 py-2.5 text-left font-medium">IP</th>
              <th className="px-4 py-2.5 text-left font-medium">질문</th>
              <th className="w-[72px] px-4 py-2.5 text-left font-medium">분기</th>
              <th className="w-[68px] px-4 py-2.5 text-center font-medium">시간대</th>
              <th className="w-[60px] px-4 py-2.5 text-center font-medium">환각</th>
              <th className="w-[72px] px-4 py-2.5 text-center font-medium">피드백</th>
              <SortTh sp={sp} col="total_ms" label="응답" align="right" w="w-[76px]" />
              <SortTh sp={sp} col="tokens" label="토큰" align="right" w="w-[84px]" />
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
                  <td className="truncate whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted-foreground">
                    {r.ip ? (
                      <Link href={href(sp, { ip: r.ip })} className="hover:text-primary hover:underline">
                        {r.ip}
                      </Link>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      className="block w-full truncate text-left text-foreground hover:text-primary hover:underline"
                    >
                      {r.query}
                    </button>
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
                      <span className="text-xs font-semibold text-primary">도움</span>
                    ) : r.feedback === -1 ? (
                      <span className="text-xs font-semibold text-destructive">아쉬움</span>
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

      {/* 페이지네이션 — 범위·이전/다음(페이지당 콤보는 표 상단으로 이동). 필터 내
          총건수(total)로 페이지 수를 산출한다. */}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-x-6 gap-y-2 py-1">
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

      {selectedId != null && <LogDetailDialog key={selectedId} id={selectedId} onClose={closeDetail} />}
    </>
  );
}

// ── 상세 팝업 ────────────────────────────────────────────────────────────────
function fmtScore(v: number | null) {
  return v == null ? "–" : v.toFixed(3);
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{children}</div>
  );
}

// 로그 상세 모달. Esc·바깥 클릭·닫기 버튼으로 닫고, 열려 있는 동안 배경 스크롤을 잠근다.
function LogDetailDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const [detail, setDetail] = useState<QueryLogDetail | null>(null);
  const [error, setError] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 대상이 바뀌면 부모가 key 로 remount 하므로 상태 초기화는 필요 없다.
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/logs/${id}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { detail: QueryLogDetail };
        if (!cancelled) setDetail(data.detail);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`로그 #${id} 상세`}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-6 py-4">
          <h2 className="font-mono text-sm font-semibold text-foreground">
            #{id}
            {detail && (
              <span className="ml-2 font-sans font-normal text-muted-foreground">{fmtTime(detail.created_at)}</span>
            )}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md px-1.5 text-sm text-muted-foreground transition hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            닫기 ✕
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto px-6 py-5">
          {error ? (
            <p className="py-10 text-center text-sm text-destructive">상세를 불러오지 못했습니다.</p>
          ) : !detail ? (
            <p className="py-10 text-center text-sm text-muted-foreground">불러오는 중…</p>
          ) : (
            <LogDetailBody detail={detail} />
          )}
        </div>
      </div>
    </div>
  );
}

function LogDetailBody({ detail }: { detail: QueryLogDetail }) {
  return (
    <>
      {/* 메타 스트립 — 칩형 한두 줄로 압축. 질의·응답 본문이 팝업의 주인공이 되도록 상단에 붙인다. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border/60 pb-4">
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
          <SectionLabel>질문</SectionLabel>
          <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground">{detail.query}</p>
        </div>
        <div>
          <SectionLabel>답변</SectionLabel>
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
            <SectionLabel>피드백 메모</SectionLabel>
            <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground/90">
              {detail.feedback_note}
            </p>
          </div>
        )}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div>
          <SectionLabel>인용 검증 (cited_law_refs)</SectionLabel>
          <Json value={detail.cited_law_refs} />
        </div>
        <div>
          <SectionLabel>법령 참조 (law_refs)</SectionLabel>
          <Json value={detail.law_refs} />
        </div>
        <div>
          <SectionLabel>의도 분해 (intents)</SectionLabel>
          <Json value={detail.intents} />
        </div>
        <div>
          <SectionLabel>근거 문서 (retrieved)</SectionLabel>
          <Json value={detail.retrieved} />
        </div>
        <div>
          <SectionLabel>문서 id (retrieved_doc_ids)</SectionLabel>
          <Json value={detail.retrieved_doc_ids} />
        </div>
        <div>
          <SectionLabel>API 사용량 (api_usage)</SectionLabel>
          <Json value={detail.api_usage} />
        </div>
      </div>
    </>
  );
}
