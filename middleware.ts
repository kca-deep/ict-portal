import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, verifySession } from "@/lib/admin-auth";

// /api/ingest 는 운영자 전용 색인 API. 시크릿 헤더가 없거나 틀리면 "존재 은닉"을 위해
// 없는 경로로 rewrite 한다 — Next 가 진짜 없는 라우트와 같은 404(상태·content-type·
// 페이지 구조·크기 동일)로 응답하므로 401/403 신호와 plain-text 지문이 사라진다.
// 한계: Next 404 페이지는 "요청 경로"를 본문에 반영하는데, /api/ingest 는 실제로
// 존재해 자기 자신으로 rewrite 할 수 없다. 따라서 반영되는 경로가 rewrite 대상으로
// 바뀌어 바이트 완전 일치는 구조상 불가(잔여 지문 ~수십 바이트). 401/403 제거가 목적.
//
// /admin/* 는 관리자 전용 화면. 로그인이 없어 서명 httpOnly 쿠키로 보호한다 —
// 쿠키가 없거나 서명·만료가 유효하지 않으면 로그인 폼으로 돌려보낸다.
// (시크릿은 미들웨어 번들을 가볍게 유지하려 process.env 에서 직접 읽는다.)
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname === "/api/ingest") {
    const secret = process.env.INGEST_SECRET;
    if (!secret || req.headers.get("x-ingest-secret") !== secret) {
      return NextResponse.rewrite(new URL("/not-found", req.url));
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/admin")) {
    // 로그인 폼 자체는 통과시켜야 비밀번호를 입력할 수 있다.
    if (pathname === "/admin/login") return NextResponse.next();

    const secret = process.env.ADMIN_PASSWORD;
    const token = req.cookies.get(ADMIN_COOKIE)?.value;
    const authed = !!secret && !!token && (await verifySession(token, secret));
    if (!authed) {
      return NextResponse.redirect(new URL("/admin/login", req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/ingest", "/admin/:path*"],
};
