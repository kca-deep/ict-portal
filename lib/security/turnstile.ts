import { env } from "@/lib/env";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Turnstile 게이트 활성 판정(단일 진실원).
 * - TURNSTILE_ENABLED 가 "false" 면 강제 OFF.
 * - site/secret 키 둘 다 있어야 ON. 하나라도 없으면 기존 방식(게이트 없음).
 */
export function turnstileEnabled(): boolean {
  if (env.TURNSTILE_ENABLED === "false") return false;
  return Boolean(
    env.NEXT_PUBLIC_TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY,
  );
}

/**
 * 토큰을 Cloudflare 로 검증. 게이트 비활성이면 항상 통과(true).
 * 활성인데 토큰 없거나 검증 실패면 false(fail-closed).
 */
export async function verifyTurnstile(
  token: string | undefined,
  ip?: string,
): Promise<boolean> {
  if (!turnstileEnabled()) return true;
  if (!token) return false;

  const form = new URLSearchParams();
  form.set("secret", env.TURNSTILE_SECRET_KEY!);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error("[turnstile] verify failed:", (err as Error).message);
    return false; // 활성 상태에서 검증 불가면 차단
  }
}
