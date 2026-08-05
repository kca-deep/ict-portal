import { NextRequest, NextResponse } from "next/server";
import {
  adminCookieName,
  adminSessionSecret,
  verifySession,
} from "@/lib/admin-auth";
import {
  ipAllowed,
  isLoopbackHost,
  parseAllowlist,
  resolveClientIp,
} from "@/lib/admin-ip";

// 정적 호환 CSP. ⚠️ 이전의 nonce+'strict-dynamic' 방식은 프로덕션 전면 장애 원인이었다:
// Turbopack 프로덕션 빌드가 미들웨어 nonce 를 문서 스크립트에 부착하지 않는 것을 실측
// (정적 프리렌더 챗/로그인 0/22·0/21, force-dynamic 관리자도 0/37). 'strict-dynamic' 은
// 'self' 허용마저 무시하므로 _next/static 청크 전부가 차단 → 전 페이지 하이드레이션
// 실패(전송 버튼이 입력해도 비활성 그대로). script-src 는 'self'+'unsafe-inline' 로
// 전환한다 — 외부 출처 스크립트는 여전히 차단되고, 인라인만 허용(Next 부트스트랩 필요).
// style 은 로그인 페이지 인라인 <style> 때문에 'unsafe-inline' 유지(스타일은 XSS 위험 낮음).
// 교차 출처 허용 목록(선택) — ALLOWED_ORIGINS(쉼표 구분, 예: https://pims.vercel.app).
// 이 앱은 모든 fetch 가 상대경로(동일 출처)라 미설정 기본값으로도 프로덕션 정상 동작한다.
// 다른 출처의 페이지가 이 API 를 부르거나 프리뷰↔프로덕션 교차 호출 구성이 생길 때만
// 설정. 설정 시 ① /api/* CORS 응답 헤더 ② CSP connect-src 에 함께 반영된다.
function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function buildCsp(): string {
  const prod = process.env.NODE_ENV === "production";
  const scriptSrc = prod
    ? "'self' 'unsafe-inline'"
    : "'self' 'unsafe-inline' 'unsafe-eval'"; // dev 는 Turbopack HMR 이 eval 사용
  const connectSrc = ["'self'", ...allowedOrigins()].join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

// 통과 응답에 CSP 를 붙인다(브라우저 적용용 응답 헤더만 — nonce 미사용이라 요청 헤더
// 주입 불필요). rewriteTo 가 있으면 그 경로로 rewrite(시크릿 슬러그 → /admin 매핑용).
function withCsp(req: NextRequest, rewriteTo?: URL): NextResponse {
  const res = rewriteTo ? NextResponse.rewrite(rewriteTo) : NextResponse.next();
  res.headers.set("content-security-policy", buildCsp());
  return res;
}

// 존재 은닉 404 — 진짜 없는 라우트와 동일한 응답(401/403 신호·지문 제거). ingest 와 동일 문법.
function hidden(req: NextRequest): NextResponse {
  return NextResponse.rewrite(new URL("/not-found", req.url));
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

  // ── 관리자 표면 보호 ─────────────────────────────────────────────────────
  // A) 시크릿 슬러그: ADMIN_PATH_SECRET 설정 시 관리자 화면은 /{slug}/* 로만 접근
  //    (내부적으로 /admin/* 에 rewrite). /admin 직접 접근은 404 은닉. 미설정이면
  //    기존 /admin 그대로(롤아웃 안전 — env 만으로 켜고 끔).
  // B) IP 허용목록: ADMIN_ALLOWED_IPS(쉼표, IPv4/CIDR). 프로덕션 전용 — 미설정이면
  //    기본 거부(관리자 표면 전체 404). 기관 고정 IP(SSLVPN egress) 전제. 로컬
  //    개발은 검사 생략. 화면(page)과 API(/api/admin/*) 모두 커버.
  // 슬러그 앞뒤 슬래시는 정규화 — "/pims-x" 처럼 넣어도 "pims-x" 로 동작(설정 실수 방어).
  const slug = (process.env.ADMIN_PATH_SECRET ?? "").replace(/^\/+|\/+$/g, "");

  // C) 로컬 구동 예외: 루프백 호스트로 붙은 접속에는 슬러그 은닉·IP 허용목록을 걸지
  //    않는다 — `pnpm dev`/`pnpm start` 로 띄운 앱에서 /admin 이 바로 열려야 배포 전
  //    스모크(관리자 로그인 1회)가 가능하다. 판정에 VERCEL 런타임 플래그를 함께 두어
  //    배포 환경에서는 Host 헤더를 위조해도 이 예외에 닿지 않게 한다. 비밀번호 세션
  //    검사는 로컬에서도 그대로 유지된다(열리는 것은 로그인 폼까지).
  const isLocal = !process.env.VERCEL && isLoopbackHost(req.nextUrl.hostname);
  const directAdmin = pathname === "/admin" || pathname.startsWith("/admin/");

  // 슬러그 모드에서 /admin 직접 접근은 은닉(내부 경로 노출 방지). 로컬은 예외.
  if (slug && directAdmin && !isLocal) {
    return hidden(req);
  }

  // 로컬에서 /admin 으로 들어온 요청은 슬러그 rewrite 없이 그대로 처리한다.
  const adminBase = slug && !(isLocal && directAdmin) ? `/${slug}` : "/admin";
  const isAdminPage = pathname === adminBase || pathname.startsWith(`${adminBase}/`);
  const isAdminApi = pathname.startsWith("/api/admin");

  if (isAdminPage || isAdminApi) {
    if (process.env.NODE_ENV === "production" && !isLocal) {
      const allow = parseAllowlist(process.env.ADMIN_ALLOWED_IPS);
      const ip = resolveClientIp(
        req.headers.get("x-forwarded-for"),
        req.nextUrl.hostname,
      );
      if (!ipAllowed(ip, allow)) return hidden(req);
    }
  }

  if (isAdminPage) {
    // IP 통과 후에만 세션 검사. 미인증은 (슬러그) 로그인 폼으로.
    if (pathname !== `${adminBase}/login`) {
      const secret = adminSessionSecret();
      const token = req.cookies.get(adminCookieName())?.value;
      const authed = !!secret && !!token && (await verifySession(token, secret));
      if (!authed) {
        return NextResponse.redirect(new URL(`${adminBase}/login`, req.url));
      }
    }
    // 슬러그 경로를 내부 /admin 라우트로 rewrite. 문서 요청은 CSP 도 함께.
    // (로컬 /admin 직접 접근은 adminBase 가 이미 "/admin" 이라 rewrite 대상이 아니다.)
    if (adminBase !== "/admin") {
      const rest = pathname.slice(adminBase.length); // "" | "/login" | ...
      const target = new URL(`/admin${rest}${req.nextUrl.search}`, req.url);
      const isDoc = req.headers.get("accept")?.includes("text/html");
      return isDoc ? withCsp(req, target) : NextResponse.rewrite(target);
    }
  }

  // API CORS(선택) — ALLOWED_ORIGINS 에 명시된 출처의 교차 호출만 허용한다.
  // 관리자 표면 게이트(IP·쿠키) 뒤에 두어 은닉 404 가 항상 우선한다.
  const origin = req.headers.get("origin");
  const corsOrigin = origin && allowedOrigins().includes(origin) ? origin : null;
  if (pathname.startsWith("/api/") && req.method === "OPTIONS" && corsOrigin) {
    return new NextResponse(null, { status: 204, headers: corsHeaders(corsOrigin) });
  }

  // CSP 는 HTML 문서 요청(페이지 내비게이션)에만 붙인다. API 응답·BotID 동일출처
  // 챌린지·서브리소스에 nonce 없는 CSP 를 씌우면 스크립트/XHR 이 막힐 수 있어, nonce 가
  // 실제로 의미 있는 문서 로드로 한정한다(script-src 는 strict-dynamic 으로 전파).
  const isDocument = req.headers.get("accept")?.includes("text/html");
  const res = isDocument ? withCsp(req) : NextResponse.next();
  if (pathname.startsWith("/api/") && corsOrigin) {
    for (const [k, v] of Object.entries(corsHeaders(corsOrigin))) res.headers.set(k, v);
  }
  return res;
}

export const config = {
  // 정적 자산·이미지 최적화·favicon 을 제외한 모든 경로(CSP 적용) + ingest.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
