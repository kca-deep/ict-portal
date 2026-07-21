import { Ratelimit } from "@upstash/ratelimit";
import { env } from "@/lib/env";
import { getRedis, kstDayKey, DAILY_TTL_SEC, type RedisClient } from "./redis";

// 공개(no-login) 챗 엔드포인트의 요청 레벨 방어선 — IP 분당(슬라이딩) + IP 일일 +
// 전역 일일 호출 상한. 저장소는 Upstash Redis. 무인증 유료 엔드포인트라 프로덕션은
// fail-closed(리미터 미구성/오류 시 차단): 가용성보다 비용·남용 보호를 우선한다.

export function rateLimitEnabled(): boolean {
  // 프로덕션 기본 활성(RATE_LIMIT_ENABLED="false" 로만 해제), 로컬은 opt-in("true").
  const flag = env.RATE_LIMIT_ENABLED;
  if (process.env.NODE_ENV === "production") return flag !== "false";
  return flag === "true";
}

// 리미터 미구성/오류 시 차단할지(프로덕션=차단, 로컬=통과).
function failClosed(): boolean {
  return process.env.NODE_ENV === "production";
}

// 분당 슬라이딩 윈도 리미터 — 인스턴스 재사용(Upstash 권장).
let ipMinute: Ratelimit | null = null;
function ipMinuteLimiter(redis: RedisClient): Ratelimit {
  if (!ipMinute) {
    ipMinute = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(env.RATE_LIMIT_PER_MIN, "60 s"),
      prefix: "rl:ipmin",
      analytics: false,
    });
  }
  return ipMinute;
}

// 관리자 로그인 시도 브루트포스 억제 — IP당 10분 10회. 저장소 오류·미구성 시엔
// fail-open(운영자 락아웃 방지 우선 — 단일 신뢰 계정이라 일시 완화 위험이 낮다).
let loginLimiter: Ratelimit | null = null;
export async function checkLoginRateLimit(
  ip: string | undefined,
): Promise<{ ok: boolean }> {
  if (!rateLimitEnabled()) return { ok: true };
  const redis = getRedis();
  if (!redis) return { ok: true };
  try {
    if (!loginLimiter) {
      loginLimiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(10, "600 s"),
        prefix: "rl:login",
        analytics: false,
      });
    }
    const r = await loginLimiter.limit(ip ?? "unknown");
    return { ok: r.success };
  } catch (err) {
    console.error("[ratelimit] login check failed:", (err as Error).message);
    return { ok: true };
  }
}

// 피드백(👍/👎) 남용 억제 — IP당 분당 30회. 무인증 쓰기 엔드포인트라 대량 호출로
// 만족도 KPI 를 조작하는 것을 막는다. 유료 LLM 을 부르지 않는 경량 쓰기이므로
// 저장소 오류·미구성 시 fail-open(로그인 리미터와 같은 정책 — 가용성 우선).
let feedbackLimiter: Ratelimit | null = null;
export async function checkFeedbackRateLimit(
  ip: string | undefined,
): Promise<{ ok: boolean }> {
  if (!rateLimitEnabled()) return { ok: true };
  const redis = getRedis();
  if (!redis) return { ok: true };
  try {
    if (!feedbackLimiter) {
      feedbackLimiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(30, "60 s"),
        prefix: "rl:fb",
        analytics: false,
      });
    }
    const r = await feedbackLimiter.limit(ip ?? "unknown");
    return { ok: r.success };
  } catch (err) {
    console.error("[ratelimit] feedback check failed:", (err as Error).message);
    return { ok: true };
  }
}

// 일일 카운터 원자 증가 + 첫 증가 시 TTL 부여. 반환은 증가 후 값.
async function incrDaily(redis: RedisClient, key: string): Promise<number> {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, DAILY_TTL_SEC);
  return n;
}

/**
 * 요청 레벨 레이트리밋 점검. 통과면 ok:true.
 * 비활성이면 즉시 통과. 활성인데 저장소가 없거나 오류면 failClosed() 정책을 따른다.
 */
export async function checkRateLimit(
  ip: string | undefined,
): Promise<{ ok: boolean }> {
  if (!rateLimitEnabled()) return { ok: true };
  const redis = getRedis();
  if (!redis) return { ok: !failClosed() };

  const ipKey = ip ?? "unknown";
  const day = kstDayKey();
  try {
    const min = await ipMinuteLimiter(redis).limit(ipKey);
    if (!min.success) return { ok: false };

    const [ipDaily, globalDaily] = await Promise.all([
      incrDaily(redis, `rl:ipday:${ipKey}:${day}`),
      incrDaily(redis, `rl:gday:${day}`),
    ]);
    if (ipDaily > env.RATE_LIMIT_IP_DAILY_CAP) return { ok: false };
    if (globalDaily > env.RATE_LIMIT_DAILY_CAP) return { ok: false };

    return { ok: true };
  } catch (err) {
    console.error("[ratelimit] check failed:", (err as Error).message);
    return { ok: !failClosed() };
  }
}
