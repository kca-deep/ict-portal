import type { QueryLogFilter, SortKey } from "@/lib/db/query-log";

// 관리자 로그 API 공통 필터 파서. 목록(/api/admin/logs)과 엑셀 내보내기
// (/api/admin/logs/export)가 같은 쿼리 파라미터 문법을 쓰도록 한 곳에서 파싱한다.
// 값은 전부 화이트리스트 검증 — 임의 컬럼·임의 정렬로 조회되지 않게 한다.
// (limit/offset 은 페이징이 있는 목록 API 만의 관심사라 호출부가 따로 처리한다.)
export function parseLogFilter(sp: URLSearchParams): QueryLogFilter {
  const routeParam = sp.get("route");
  const route =
    routeParam === "unified" ||
    routeParam === "regulation" ||
    routeParam === "law" ||
    routeParam === "out_of_scope"
      ? routeParam
      : undefined;

  const sortParam = sp.get("sort");
  const sort: SortKey | undefined = (
    ["created_at", "top_score", "total_ms", "tokens", "feedback"] as const
  ).includes(sortParam as SortKey)
    ? (sortParam as SortKey)
    : undefined;
  const dirParam = sp.get("dir");
  const sortDir = dirParam === "asc" ? "asc" : dirParam === "desc" ? "desc" : undefined;

  return {
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
}
