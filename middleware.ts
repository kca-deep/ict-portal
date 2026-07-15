import { NextRequest, NextResponse } from "next/server";
import {
  adminCookieName,
  adminSessionSecret,
  verifySession,
} from "@/lib/admin-auth";

// 요청별 nonce 기반 CSP 를 발급한다. Next 는 요청 헤더의 CSP 에서 nonce 를 읽어
// 자기 하이드레이션 스크립트에 부여하므로, script-src 를 'strict-dynamic'+nonce 로
// 엄격히 잠글 수 있다(외부/인라인 스크립트 차단). style 은 로그인 페이지의 인라인
// <style> 과 style={{}} 속성 때문에 'unsafe-inline' 을 유지한다(스타일은 XSS 위험이
// 낮음). dev 는 Turbopack HMR 이 eval/inline 을 써서 엄격 CSP 가 개발을 깨므로 완화.
function buildCsp(nonce: string): string {
  const prod = process.env.NODE_ENV === "production";
  const scriptSrc = prod
    ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
    : "'self' 'unsafe-inline' 'unsafe-eval'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

// 통과 응답에 CSP 를 붙인다. nonce 를 요청 헤더(x-nonce·CSP)에 실어 Next 가 읽게 하고,
// 동일 CSP 를 응답 헤더에도 설정한다(브라우저 적용용).
function withCsp(req: NextRequest): NextResponse {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = buildCsp(nonce);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("content-security-policy", csp);
  return res;
}

// /api/ingest 는 운영자 전용 색인 API. 시크릿 헤더가 없거나 틀리면 "존재 은닉"을 위해
// 없는 경로로 rewrite 한다 — Next 가 진짜 없는 라우트와 같은 404 로 응답하므로 401/403
// 신호와 plain-text 지문이 사라진다.
//
// /admin/* 는 관리자 전용 화면. 로그인이 없어 서명 httpOnly 쿠키로 보호한다 — 쿠키가
// 없거나 서명·만료가 유효하지 않으면 로그인 폼으로 돌려보낸다.
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname === "/api/ingest") {
    const secret = process.env.INGEST_SECRET;
    if (!secret || req.headers.get("x-ingest-secret") !== secret) {
      return NextResponse.rewrite(new URL("/not-found", req.url));
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/admin") && pathname !== "/admin/login") {
    const secret = adminSessionSecret();
    const token = req.cookies.get(adminCookieName())?.value;
    const authed = !!secret && !!token && (await verifySession(token, secret));
    if (!authed) {
      return NextResponse.redirect(new URL("/admin/login", req.url));
    }
  }

  // CSP 는 HTML 문서 요청(페이지 내비게이션)에만 붙인다. API 응답·BotID 동일출처
  // 챌린지·서브리소스에 nonce 없는 CSP 를 씌우면 스크립트/XHR 이 막힐 수 있어, nonce 가
  // 실제로 의미 있는 문서 로드로 한정한다(script-src 는 strict-dynamic 으로 전파).
  const isDocument = req.headers.get("accept")?.includes("text/html");
  return isDocument ? withCsp(req) : NextResponse.next();
}

export const config = {
  // 정적 자산·이미지 최적화·favicon 을 제외한 모든 경로(CSP 적용) + ingest.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
