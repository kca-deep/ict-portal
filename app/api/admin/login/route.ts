import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_MS,
  signSession,
  timingSafeEqual,
} from "@/lib/admin-auth";

// 관리자 로그인. 비밀번호가 맞으면 서명·만료가 붙은 httpOnly 쿠키를 발급한다.
// 서명·검증은 Web Crypto 를 쓰지만 명시적으로 Node 런타임에 고정(프로젝트 정책).
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let password = "";
  try {
    const body = (await req.json()) as { password?: unknown };
    if (typeof body?.password === "string") password = body.password;
  } catch {
    // JSON 이 아니면 빈 비밀번호로 간주 → 아래에서 401.
  }

  const expected = env.ADMIN_PASSWORD;
  if (!expected || !timingSafeEqual(password, expected)) {
    // 존재/부재 신호를 주지 않도록 동일한 401 로만 응답.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = await signSession(expected, Date.now() + ADMIN_SESSION_TTL_MS);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
  });
  return res;
}
