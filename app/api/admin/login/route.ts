import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_MS,
  signSession,
  timingSafeEqual,
} from "@/lib/admin-auth";

// 관리자 로그인. 아이디+비밀번호가 모두 맞으면 서명·만료가 붙은 httpOnly 쿠키를
// 발급한다. 서명·검증은 Web Crypto 를 쓰지만 명시적으로 Node 런타임에 고정(프로젝트 정책).
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let username = "";
  let password = "";
  try {
    const body = (await req.json()) as { username?: unknown; password?: unknown };
    if (typeof body?.username === "string") username = body.username;
    if (typeof body?.password === "string") password = body.password;
  } catch {
    // JSON 이 아니면 빈 자격증명으로 간주 → 아래에서 401.
  }

  const expectedUser = env.ADMIN_USERNAME;
  const expectedPass = env.ADMIN_PASSWORD;
  // 아이디·비밀번호를 각각 비교하되 결과를 AND 로 합친다. 어느 필드가 틀렸는지,
  // 계정 존재 여부를 드러내지 않도록 조기 반환 없이 동일한 401 로만 응답한다.
  const userOk = !!expectedUser && timingSafeEqual(username, expectedUser);
  const passOk = !!expectedPass && timingSafeEqual(password, expectedPass);
  if (!userOk || !passOk || !expectedPass) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = await signSession(expectedPass, Date.now() + ADMIN_SESSION_TTL_MS);
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
