import { NextResponse } from "next/server";
import { adminCookieName } from "@/lib/admin-auth";

// 관리자 로그아웃 — 세션 쿠키를 즉시 만료시킨다. 토큰은 상태 없는 서명 토큰이라
// 서버 저장소 정리는 없고, 쿠키 제거가 곧 세션 종료다. 인증 없이 호출돼도 부작용이
// 쿠키 삭제뿐이라 별도 세션 검증은 두지 않는다(CSRF 로 강제돼도 로그아웃일 뿐).
export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(adminCookieName(), "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0, // 즉시 만료
  });
  return res;
}
