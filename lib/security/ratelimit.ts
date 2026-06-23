import { getSupabaseAdmin } from "@/lib/db/supabase";
import { env } from "@/lib/env";

export function rateLimitEnabled(): boolean {
  return env.RATE_LIMIT_ENABLED === "true";
}

async function bump(bucket: string, expires: Date): Promise<number> {
  const { data, error } = await getSupabaseAdmin().rpc("increment_rate_limit", {
    p_bucket: bucket,
    p_expires: expires.toISOString(),
  });
  if (error) throw new Error(`increment_rate_limit failed: ${error.message}`);
  return (data as number) ?? 0;
}

/**
 * IP 분당 호출 + 전역 일일 호출 캡 체크(골격).
 * 비활성이면 즉시 통과. 카운터 장애 시 fail-open(가용성 우선) — 후속 개선에서 정책 재검토.
 */
export async function checkRateLimit(
  ip: string | undefined,
): Promise<{ ok: boolean }> {
  if (!rateLimitEnabled()) return { ok: true };
  try {
    const now = new Date();
    const minute = now.toISOString().slice(0, 16).replace(/[-:T]/g, ""); // YYYYMMDDHHMM
    const day = now.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
    const ipKey = ip ?? "unknown";

    const perMin = await bump(
      `ip:${ipKey}:${minute}`,
      new Date(now.getTime() + 120_000),
    );
    if (perMin > env.RATE_LIMIT_PER_MIN) return { ok: false };

    const daily = await bump(
      `global:${day}`,
      new Date(now.getTime() + 86_400_000),
    );
    if (daily > env.RATE_LIMIT_DAILY_CAP) return { ok: false };

    return { ok: true };
  } catch (err) {
    console.error("[ratelimit] check failed, allowing:", (err as Error).message);
    return { ok: true };
  }
}
