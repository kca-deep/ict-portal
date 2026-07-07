import { getSupabaseAdmin } from "@/lib/db/supabase";

// query_log 한 행. 파이프라인이 산출하는 신호를 그대로 담는다(대부분 route.ts 에 이미
// 존재하는 변수). 사용자 식별은 로그인이 없어 user_id 대신 요청 IP 로 한다(4장 레이트리밋과
// 동일 소스). insert 는 service_role(RLS 우회) — 실패해도 사용자 응답을 막지 않는다.
export type QueryLogRow = {
  ip?: string | null;
  session_id?: string | null;
  query: string;
  answer?: string | null;
  message_count?: number | null;
  answer_truncated?: boolean | null;
  route?: "regulation" | "law" | "out_of_scope" | null;
  top_score?: number | null;
  below_threshold?: boolean | null;
  gate_sufficient?: boolean | null;
  out_of_scope?: boolean | null;
  retrieved?: unknown; // jsonb [{id, score}]
  retrieved_doc_ids?: number[] | null;
  law_refs?: unknown; // jsonb [{name, lawId}]
  cited_law_refs?: unknown; // jsonb — 인용 verdict(본문 body 제외)
  citation_verified?: boolean | null;
  citation_count?: number | null;
  citation_verified_count?: number | null;
  has_hallucination?: boolean | null;
  llm_model?: string | null;
  retrieval_ms?: number | null;
  rerank_ms?: number | null;
  llm_ms?: number | null;
  ttft_ms?: number | null;
  total_ms?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  error_code?: string | null;
};

/**
 * 감사 로그 적재(fire-and-forget). 호출부는 await 하지 않는다 — 적재 지연/실패가
 * 사용자 응답에 영향을 주지 않도록, 실패는 조용히 서버 로그로만 남긴다.
 */
export async function logQuery(row: QueryLogRow): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin().from("query_log").insert(row);
    if (error) console.error("[query-log] insert failed:", error.message);
  } catch (err) {
    console.error("[query-log] insert threw:", (err as Error).message);
  }
}

// ── 관리자 대시보드 조회 (service_role 전용, RLS 우회) ──────────────────────────
// 이 함수들은 서버(서버 컴포넌트/route handler)에서만 호출한다. service_role 키가
// 브라우저로 나가면 안 되므로 클라이언트 컴포넌트에서 import 하지 않는다.

export type QueryLogFilter = {
  limit?: number;
  route?: "regulation" | "law" | "out_of_scope";
  hallucinationOnly?: boolean;
  ip?: string;
  since?: string; // ISO timestamp — created_at >= since
};

/** 로그 표 한 행(요약 컬럼만). */
export type QueryLogListItem = {
  id: number;
  created_at: string;
  ip: string | null;
  query: string;
  route: "regulation" | "law" | "out_of_scope" | null;
  top_score: number | null;
  has_hallucination: boolean | null;
  total_ms: number | null;
  ttft_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  message_count: number | null;
};

/** 상세 보기 한 행(전문·인용 verdict 등 전체). */
export type QueryLogDetail = QueryLogListItem & {
  answer: string | null;
  answer_truncated: boolean | null;
  below_threshold: boolean | null;
  gate_sufficient: boolean | null;
  out_of_scope: boolean | null;
  retrieved: unknown;
  retrieved_doc_ids: number[] | null;
  law_refs: unknown;
  cited_law_refs: unknown;
  citation_verified: boolean | null;
  citation_count: number | null;
  citation_verified_count: number | null;
  llm_model: string | null;
  retrieval_ms: number | null;
  rerank_ms: number | null;
  llm_ms: number | null;
  error_code: string | null;
};

const LIST_COLUMNS =
  "id, created_at, ip, query, route, top_score, has_hallucination, total_ms, ttft_ms, tokens_in, tokens_out, message_count";

/** 최근 로그 목록(필터·최대 건수 적용). 기본 100건. */
export async function listQueryLogs(
  filter: QueryLogFilter = {},
): Promise<QueryLogListItem[]> {
  let q = getSupabaseAdmin()
    .from("query_log")
    .select(LIST_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(filter.limit ?? 100);

  if (filter.route) q = q.eq("route", filter.route);
  if (filter.hallucinationOnly) q = q.eq("has_hallucination", true);
  if (filter.ip) q = q.eq("ip", filter.ip);
  if (filter.since) q = q.gte("created_at", filter.since);

  const { data, error } = await q;
  if (error) throw new Error(`[query-log] list failed: ${error.message}`);
  return (data ?? []) as unknown as QueryLogListItem[];
}

/** 단건 상세(전문 포함). 없으면 null. */
export async function getQueryLog(id: number): Promise<QueryLogDetail | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("query_log")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[query-log] get failed: ${error.message}`);
  return (data ?? null) as unknown as QueryLogDetail | null;
}

export type QueryLogStats = {
  total: number; // 사용량(질의 수)
  distinctUsers: number; // 이용자 수 = 고유 IP 수(로그인 없음)
  avgPerUser: number | null; // 이용률 = 총 질의 / 고유 이용자
  byRoute: { regulation: number; law: number; out_of_scope: number; unknown: number };
  hallucinationCount: number;
  citationCount: number; // 인용 총 개수(검증 대상)
  citationVerifiedCount: number; // 그중 인용 검증 통과 개수
  errorCount: number; // error_code 가 있는 요청 수
  avgTotalMs: number | null;
  avgTtftMs: number | null;
  series: { label: string; count: number }[]; // 사용량 추이(시간/일 버킷)
};

// created_at 목록을 사용량 추이 버킷으로 접는다. 조회 창 기준으로 24h 이내면 시간별,
// 그 이상이면 일별(최근 30일 상한). 서버에서 그대로 SVG 차트로 렌더한다.
function buildUsageSeries(
  times: number[],
  since: string | undefined,
): { label: string; count: number }[] {
  const now = Date.now();
  let start = since ? new Date(since).getTime() : times.length ? Math.min(...times) : now - 24 * 3600 * 1000;
  const hourly = now - start <= 2 * 24 * 3600 * 1000;
  const bucketMs = hourly ? 3600 * 1000 : 24 * 3600 * 1000;
  if (!hourly) {
    const maxSpan = 30 * 24 * 3600 * 1000; // 일별 버킷 개수 상한
    if (now - start > maxSpan) start = now - maxSpan;
  }
  const startAligned = Math.floor(start / bucketMs) * bucketMs;
  const buckets: { t: number; count: number }[] = [];
  for (let t = startAligned; t <= now; t += bucketMs) buckets.push({ t, count: 0 });
  if (buckets.length === 0) buckets.push({ t: startAligned, count: 0 });
  for (const time of times) {
    const idx = Math.floor((time - startAligned) / bucketMs);
    if (idx >= 0 && idx < buckets.length) buckets[idx].count += 1;
  }
  return buckets.map((b) => {
    const d = new Date(b.t);
    return {
      label: hourly ? `${d.getHours()}시` : `${d.getMonth() + 1}/${d.getDate()}`,
      count: b.count,
    };
  });
}

// 집계 대상 상한 — PoC 규모(소량)라 행을 가져와 JS 에서 집계한다. 창이 커지면 RPC 로 승격.
const STATS_ROW_CAP = 5000;

/** 요약 집계(필터 범위 내). 분기 비율·환각 건수·평균 지연·토큰 합계. */
export async function queryLogStats(
  filter: QueryLogFilter = {},
): Promise<QueryLogStats> {
  let q = getSupabaseAdmin()
    .from("query_log")
    .select(
      "ip, created_at, route, has_hallucination, total_ms, ttft_ms, citation_count, citation_verified_count, error_code",
    )
    .order("created_at", { ascending: false })
    .limit(STATS_ROW_CAP);

  if (filter.route) q = q.eq("route", filter.route);
  if (filter.hallucinationOnly) q = q.eq("has_hallucination", true);
  if (filter.ip) q = q.eq("ip", filter.ip);
  if (filter.since) q = q.gte("created_at", filter.since);

  const { data, error } = await q;
  if (error) throw new Error(`[query-log] stats failed: ${error.message}`);

  const rows = (data ?? []) as unknown as Array<{
    ip: string | null;
    created_at: string;
    route: string | null;
    has_hallucination: boolean | null;
    total_ms: number | null;
    ttft_ms: number | null;
    citation_count: number | null;
    citation_verified_count: number | null;
    error_code: string | null;
  }>;

  const byRoute = { regulation: 0, law: 0, out_of_scope: 0, unknown: 0 };
  const users = new Set<string>();
  const times: number[] = [];
  let hallucinationCount = 0;
  let citationCount = 0;
  let citationVerifiedCount = 0;
  let errorCount = 0;
  let totalMsSum = 0;
  let totalMsN = 0;
  let ttftMsSum = 0;
  let ttftMsN = 0;

  for (const r of rows) {
    if (r.ip) users.add(r.ip);
    times.push(new Date(r.created_at).getTime());
    if (r.route === "regulation" || r.route === "law" || r.route === "out_of_scope") {
      byRoute[r.route] += 1;
    } else {
      byRoute.unknown += 1;
    }
    if (r.has_hallucination) hallucinationCount += 1;
    if (r.error_code) errorCount += 1;
    citationCount += r.citation_count ?? 0;
    citationVerifiedCount += r.citation_verified_count ?? 0;
    if (typeof r.total_ms === "number") {
      totalMsSum += r.total_ms;
      totalMsN += 1;
    }
    if (typeof r.ttft_ms === "number") {
      ttftMsSum += r.ttft_ms;
      ttftMsN += 1;
    }
  }

  const total = rows.length;
  const distinctUsers = users.size;

  return {
    total,
    distinctUsers,
    avgPerUser: distinctUsers ? Math.round((total / distinctUsers) * 10) / 10 : null,
    byRoute,
    hallucinationCount,
    citationCount,
    citationVerifiedCount,
    errorCount,
    avgTotalMs: totalMsN ? Math.round(totalMsSum / totalMsN) : null,
    avgTtftMs: ttftMsN ? Math.round(ttftMsSum / ttftMsN) : null,
    series: buildUsageSeries(times, filter.since),
  };
}
