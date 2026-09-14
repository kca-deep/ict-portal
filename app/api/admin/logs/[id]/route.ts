import { NextRequest, NextResponse } from "next/server";
import { adminCookieName, adminSessionSecret, verifySession } from "@/lib/admin-auth";
import { getQueryLog } from "@/lib/db/query-log";

// 대시보드 로그 상세 API. 표에서 질문을 누르면 페이지 이동 없이 이 API 로 전문을 받아
// 팝업으로 띄운다. 목록 API 와 같은 이유로 관리자 세션 쿠키를 직접 검증한다.
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const secret = adminSessionSecret();
  const token = req.cookies.get(adminCookieName())?.value;
  const authed = !!secret && !!token && (await verifySession(token, secret));
  if (!authed) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    const detail = await getQueryLog(id);
    if (!detail) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ detail });
  } catch (err) {
    console.error("[admin/logs/:id] get failed:", (err as Error).message);
    return NextResponse.json({ error: "get failed" }, { status: 500 });
  }
}
