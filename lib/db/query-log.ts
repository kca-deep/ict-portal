import { getSupabaseAdmin } from "@/lib/db/supabase";
import { getKoreanHolidaysForYears } from "@/lib/holidays";

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
  // "unified"(통합 검색, 2026-07 개편 이후) — 과거 행은 "regulation"/"law"(레거시 분기).
  route?: "unified" | "regulation" | "law" | "out_of_scope" | null;
  top_score?: number | null;
  below_threshold?: boolean | null;
  gate_sufficient?: boolean | null;
  out_of_scope?: boolean | null;
  intents?: unknown; // jsonb string[] — 복합 질의 의도 분해 결과(단일 의도면 null)
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
 * 감사 로그 적재. 삽입된 행 id 를 반환한다(실패 시 null, 조용히 서버 로그로만 남김).
 * 답변 스트리밍이 끝난 뒤 성공 경로에서 await 해 id 를 피드백 상관용으로 회수하고,
 * 에러 경로 등에서는 호출부가 await 없이(void) 적재해 응답 지연을 만들지 않는다.
 */
export async function logQuery(row: QueryLogRow): Promise<number | null> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("query_log")
      .insert(row)
      .select("id")
      .single();
    if (error) {
      console.error("[query-log] insert failed:", error.message);
      return null;
    }
    return (data?.id as number | undefined) ?? null;
  } catch (err) {
    console.error("[query-log] insert threw:", (err as Error).message);
    return null;
  }
}

// ── 관리자 대시보드 조회 (service_role 전용, RLS 우회) ──────────────────────────
// 이 함수들은 서버(서버 컴포넌트/route handler)에서만 호출한다. service_role 키가
// 브라우저로 나가면 안 되므로 클라이언트 컴포넌트에서 import 하지 않는다.

export type SortKey = "created_at" | "top_score" | "total_ms" | "tokens" | "feedback";

export type QueryLogFilter = {
  limit?: number;
  offset?: number; // 페이징 시작 위치. 지정 시 range(offset, offset+limit-1) 로 조회.
  route?: "unified" | "regulation" | "law" | "out_of_scope";
  hallucinationOnly?: boolean;
  negativeOnly?: boolean; // feedback = -1 (👎) 만
  ip?: string;
  since?: string; // ISO timestamp — created_at >= since
  until?: string; // ISO timestamp — created_at <= until
  search?: string; // query|answer 부분일치(ilike)
  sort?: SortKey; // 정렬 컬럼(화이트리스트). 기본 created_at
  sortDir?: "asc" | "desc"; // 기본 desc
};

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

/** 로그 표 한 행(요약 컬럼만). */
export type QueryLogListItem = {
  id: number;
  created_at: string;
  ip: string | null;
  query: string;
  route: "unified" | "regulation" | "law" | "out_of_scope" | null;
  top_score: number | null;
  has_hallucination: boolean | null;
  total_ms: number | null;
  ttft_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  message_count: number | null;
  feedback: number | null;
};

/** 상세 보기 한 행(전문·인용 verdict 등 전체). */
export type QueryLogDetail = QueryLogListItem & {
  answer: string | null;
  answer_truncated: boolean | null;
  below_threshold: boolean | null;
  gate_sufficient: boolean | null;
  out_of_scope: boolean | null;
  intents: unknown; // string[] | null — 복합 질의 의도 분해 결과
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
  feedback: number | null;
  feedback_note: string | null;
};

const LIST_COLUMNS =
  "id, created_at, ip, query, route, top_score, has_hallucination, total_ms, ttft_ms, tokens_in, tokens_out, message_count, feedback";

/** 최근 로그 목록(필터·최대 건수 적용). 기본 100건. */
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
  byRoute: { unified: number; regulation: number; law: number; out_of_scope: number; unknown: number };
  hallucinationCount: number;
  citationCount: number; // 인용 총 개수(검증 대상)
  citationVerifiedCount: number; // 그중 인용 검증 통과 개수
  errorCount: number; // error_code 가 있는 요청 수
  positiveCount: number; // 👍(+1) 수
  ratedCount: number; // 평가된(👍/👎) 수 = 만족도 분모
  restDayCount: number; // KST 기준 쉬는 날(주말+공휴일·대체·선거일) 사용 건수
  weeknightCount: number; // KST 기준 평일 저녁·심야(18시~다음날 6시) 사용 건수 (쉬는 날 제외)
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

// created_at(UTC 저장)을 KST(UTC+9) 벽시계로 환산해 요일·시각·날짜키·연도를 얻는다.
// Vercel 서버는 UTC 라 getHours()/getDay() 를 그대로 쓰면 9시간 어긋나므로, 타임스탬프에
// +9h 한 뒤 getUTC*() 로 KST 값을 읽는다(서버 로컬 TZ 무관). dateKey 는 공휴일 집합
// 대조용 "YYYY-MM-DD".
const KST_OFFSET_MS = 9 * 3600 * 1000;
function kstInfo(iso: string): { day: number; hour: number; dateKey: string; year: number } {
  const d = new Date(new Date(iso).getTime() + KST_OFFSET_MS);
  const year = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return {
    day: d.getUTCDay(), // 0=일 … 6=토
    hour: d.getUTCHours(),
    dateKey: `${year}-${mm}-${dd}`,
    year,
  };
}

/** 요약 집계(필터 범위 내). 분기 비율·환각 건수·평균 지연·토큰 합계. */
export async function queryLogStats(
  filter: QueryLogFilter = {},
): Promise<QueryLogStats> {
  let q = getSupabaseAdmin()
    .from("query_log")
    .select(
      "ip, created_at, route, has_hallucination, total_ms, ttft_ms, citation_count, citation_verified_count, error_code, feedback",
    )
    .order("created_at", { ascending: false })
    .limit(STATS_ROW_CAP);
  q = applyFilter(q, filter);

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
    feedback: number | null;
  }>;

  const byRoute = { unified: 0, regulation: 0, law: 0, out_of_scope: 0, unknown: 0 };
  const users = new Set<string>();
  const times: number[] = [];
  let hallucinationCount = 0;
  let citationCount = 0;
  let citationVerifiedCount = 0;
  let errorCount = 0;
  let positiveCount = 0;
  let ratedCount = 0;
  let restDayCount = 0;
  let weeknightCount = 0;
  let totalMsSum = 0;
  let totalMsN = 0;
  let ttftMsSum = 0;
  let ttftMsN = 0;

  // 쉬는 날 판정용 공휴일 집합 — 데이터에 등장하는 연도만 조회(캐싱·폴백은 lib/holidays).
  const years = new Set<number>();
  for (const r of rows) years.add(kstInfo(r.created_at).year);
  const holidayByYear = await getKoreanHolidaysForYears([...years]);

  for (const r of rows) {
    if (r.ip) users.add(r.ip);
    times.push(new Date(r.created_at).getTime());
    // 쉬는 날(주말+공휴일)과 평일 저녁·심야를 상호배타로 카운트한다. 쉬는 날은 하루 전체를
    // 쉬는 날 버킷이 가져가므로, 평일 저녁·심야는 쉬는 날이 아닐 때만 잡힌다(교집합 없음).
    const { day, hour, dateKey, year } = kstInfo(r.created_at);
    const isRestDay =
      day === 0 || day === 6 || (holidayByYear.get(year)?.has(dateKey) ?? false);
    if (isRestDay) {
      restDayCount += 1;
    } else if (hour >= 18 || hour < 6) {
      weeknightCount += 1;
    }
    if (r.route === "unified" || r.route === "regulation" || r.route === "law" || r.route === "out_of_scope") {
      byRoute[r.route] += 1;
    } else {
      byRoute.unknown += 1;
    }
    if (r.has_hallucination) hallucinationCount += 1;
    if (r.error_code) errorCount += 1;
    if (r.feedback === 1) {
      positiveCount += 1;
      ratedCount += 1;
    } else if (r.feedback === -1) {
      ratedCount += 1;
    }
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
    positiveCount,
    ratedCount,
    restDayCount,
    weeknightCount,
    avgTotalMs: totalMsN ? Math.round(totalMsSum / totalMsN) : null,
    avgTtftMs: ttftMsN ? Math.round(ttftMsSum / ttftMsN) : null,
    series: buildUsageSeries(times, filter.since),
  };
}
