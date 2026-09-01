import { NextRequest, NextResponse } from "next/server";
import { adminCookieName, adminSessionSecret, verifySession } from "@/lib/admin-auth";
import { listQueryLogs, type QueryLogFilter } from "@/lib/db/query-log";
import { parseLogFilter } from "@/lib/admin/log-filter";

// 대시보드 로그 표 페이징 API. offset/limit 로 한 페이지를 반환한다(페이지 크기는
// 화이트리스트 20~300). 미들웨어 matcher 는 /api/admin/* 을 게이트하지 않으므로
// (로그인만 예외) 여기서 관리자 세션 쿠키를 직접 검증한다. service_role 로 읽으므로 인증 필수.
export const runtime = "nodejs";

// 페이지 크기 화이트리스트 — 임의 값으로 대량 조회하는 것을 막는다(표 UI 선택지와 일치).
const ALLOWED_LIMITS = [10, 20, 50, 100, 200, 300];

export async function GET(req: NextRequest) {
  const secret = adminSessionSecret();
  const token = req.cookies.get(adminCookieName())?.value;
  const authed = !!secret && !!token && (await verifySession(token, secret));
  if (!authed) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const offset = Math.max(0, Math.trunc(Number(sp.get("offset")) || 0));
  const limParam = Math.trunc(Number(sp.get("limit")));
  const limit = ALLOWED_LIMITS.includes(limParam) ? limParam : 10;

  // 모집단 필터는 엑셀 내보내기와 공유(lib/admin/log-filter), 페이징만 여기서 얹는다.
  const filter: QueryLogFilter = { ...parseLogFilter(sp), limit, offset };

  try {
    const rows = await listQueryLogs(filter);
    return NextResponse.json({ rows });
  } catch (err) {
    console.error("[admin/logs] list failed:", (err as Error).message);
    return NextResponse.json({ error: "list failed" }, { status: 500 });
  }
}
