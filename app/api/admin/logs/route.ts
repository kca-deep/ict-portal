import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, verifySession } from "@/lib/admin-auth";
import { listQueryLogs, type QueryLogFilter, type SortKey } from "@/lib/db/query-log";

// 대시보드 "더 조회하기"용 페이징 API. 한 번에 최대 20건 반환.
// 미들웨어 matcher 는 /api/admin/* 을 게이트하지 않으므로(로그인만 예외) 여기서
// 관리자 세션 쿠키를 직접 검증한다. service_role 로 읽으므로 인증은 필수.
export const runtime = "nodejs";

const PAGE = 10;

export async function GET(req: NextRequest) {
  const secret = process.env.ADMIN_PASSWORD;
  const token = req.cookies.get(ADMIN_COOKIE)?.value;
  const authed = !!secret && !!token && (await verifySession(token, secret));
  if (!authed) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const offset = Math.max(0, Math.trunc(Number(sp.get("offset")) || 0));
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

  const filter: QueryLogFilter = {
    limit: PAGE,
    offset,
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

  try {
    const rows = await listQueryLogs(filter);
    return NextResponse.json({ rows });
  } catch (err) {
    console.error("[admin/logs] list failed:", (err as Error).message);
    return NextResponse.json({ error: "list failed" }, { status: 500 });
  }
}
