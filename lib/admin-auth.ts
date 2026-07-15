// 관리자 세션 쿠키 서명/검증. 이 서비스는 로그인이 없어 관리자 화면만 단일
// ADMIN_PASSWORD 로 보호한다. 비밀번호를 맞히면 서명(HMAC-SHA256)·만료가 붙은
// httpOnly 쿠키로 세션을 유지한다(스크립트가 못 읽는 httpOnly + 위조 불가 서명).
//
// Web Crypto(subtle)와 btoa 만 사용 — 미들웨어(경량 런타임)와 라우트(Node) 양쪽에서
// 동작한다. lib/env.ts 를 import 하지 않아 미들웨어 번들이 무거워지지 않는다.
// 서명 키는 별도 시크릿 env 없이 ADMIN_PASSWORD 자체를 쓴다(비번을 아는 것이 신뢰
// 기준이므로 충분). 비번을 바꾸면 기존 세션은 자동 무효화된다.

// 관리자 세션 쿠키명. 프로덕션은 `__Host-` 프리픽스로 강화한다 — 브라우저가
// Secure + Path=/ + Domain 미지정을 강제해 하위 도메인發 쿠키 주입을 차단한다.
// 로컬(http)은 Secure 쿠키가 저장 안 되므로 프리픽스 없이 둔다.
export function adminCookieName(): string {
  return process.env.NODE_ENV === "production" ? "__Host-pims_admin" : "pims_admin";
}

/**
 * 세션 서명 키 — ADMIN_SESSION_SECRET 우선, 없으면 ADMIN_PASSWORD 로 폴백.
 * 상용에선 비번과 분리(비번 변경이 세션을 깨지 않고, 키 유출 대응을 분리).
 * env 를 import 하지 않아 미들웨어 번들을 가볍게 유지(process.env 직접 읽음).
 */
export function adminSessionSecret(): string | undefined {
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || undefined;
}

/** 관리자 세션 유효기간(발급 시점부터). */
export const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8시간

const encoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return toBase64Url(sig);
}

/** 길이·내용 비교를 상수 시간에 가깝게 — 타이밍 사이드채널 완화(PoC 수준). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `${exp}.${sig}` 형식의 세션 토큰 발급. exp 는 만료 epoch(ms). */
export async function signSession(secret: string, exp: number): Promise<string> {
  const sig = await hmac(secret, String(exp));
  return `${exp}.${sig}`;
}

/** 토큰의 서명 유효성 + 만료 여부 검증. */
export async function verifySession(token: string, secret: string): Promise<boolean> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const expPart = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(expPart);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = await hmac(secret, expPart);
  return timingSafeEqual(sig, expected);
}
