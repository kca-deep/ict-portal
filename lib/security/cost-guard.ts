import { env } from "@/lib/env";
import { getRedis, kstDayKey, DAILY_TTL_SEC, type RedisClient } from "./redis";
import { rateLimitEnabled } from "./ratelimit";
import { sendCostAlert } from "@/lib/alerts/email";

// 비용 가드 — 요청 수 캡(ratelimit)과 별개로 실제 LLM **토큰 사용량**을 IP·전역
// 일일 예산으로 통제한다. 처리 전 사전 점검(이미 예산 초과면 차단)하고, 처리 후
// 소비 토큰을 누적한다. 저장소는 Upstash Redis. 프로덕션은 fail-closed.

function failClosed(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * 사전 점검 — 오늘 이미 IP 또는 전역 토큰 예산을 소진했으면 차단.
 * 비활성이면 통과, 저장소 없음/오류면 failClosed 정책.
 */
export async function checkCostBudget(
  ip: string | undefined,
): Promise<{ ok: boolean }> {
  if (!rateLimitEnabled()) return { ok: true };
  const redis = getRedis();
  if (!redis) return { ok: !failClosed() };

  const day = kstDayKey();
  const ipKey = `cost:ipday:${ip ?? "unknown"}:${day}`;
  const gKey = `cost:gday:${day}`;
  try {
    const [ipTok, gTok] = await Promise.all([
      redis.get<number>(ipKey),
      redis.get<number>(gKey),
    ]);
    if ((ipTok ?? 0) >= env.COST_IP_DAILY_TOKENS) return { ok: false };
    if ((gTok ?? 0) >= env.COST_GLOBAL_DAILY_TOKENS) return { ok: false };
    return { ok: true };
  } catch (err) {
    console.error("[cost-guard] check failed:", (err as Error).message);
    return { ok: !failClosed() };
  }
}

// incrby 후 첫 증가면 TTL 부여. 첫 증가는 0 에서 시작하므로 반환값 === by.
async function incrByDaily(
  redis: RedisClient,
  key: string,
  by: number,
): Promise<number> {
  const n = await redis.incrby(key, by);
  if (n === by) await redis.expire(key, DAILY_TTL_SEC);
  return n;
}

/**
 * 처리 후 소비 토큰(입력+출력) 누적. 임계치(ALERT_COST_THRESHOLD) 교차 시 관리자
 * 이메일 경고를 하루 1회(Redis 플래그 디듈) 발송한다. 실패해도 조용히 로그만.
 */
export async function recordTokens(
  ip: string | undefined,
  tokens: number,
): Promise<void> {
  if (!rateLimitEnabled() || tokens <= 0) return;
  const redis = getRedis();
  if (!redis) return;

  const day = kstDayKey();
  const ipLabel = ip ?? "unknown";
  try {
    const [ipTok, gTok] = await Promise.all([
      incrByDaily(redis, `cost:ipday:${ipLabel}:${day}`, tokens),
      incrByDaily(redis, `cost:gday:${day}`, tokens),
    ]);
    await Promise.all([
      maybeAlert(redis, "ip", ipLabel, ipTok, env.COST_IP_DAILY_TOKENS, day),
      maybeAlert(redis, "global", "전역", gTok, env.COST_GLOBAL_DAILY_TOKENS, day),
    ]);
  } catch (err) {
    console.error("[cost-guard] record failed:", (err as Error).message);
  }
}

// 임계치 교차 시 하루 1회 경고. Redis SET NX 로 오늘 이미 보냈는지 원자적 판정.
async function maybeAlert(
  redis: RedisClient,
  scope: "ip" | "global",
  label: string,
  used: number,
  cap: number,
  day: string,
): Promise<void> {
  if (used < cap * env.ALERT_COST_THRESHOLD) return;
  const flagKey = `alert:cost:${scope}:${label}:${day}`;
  const first = await redis.set(flagKey, "1", { nx: true, ex: DAILY_TTL_SEC });
  if (first !== "OK") return; // 오늘 이미 발송
  const pct = Math.round((used / cap) * 100);
  const who = scope === "ip" ? `IP ${label}` : "전역";
  await sendCostAlert(
    `[PIMS] 일일 토큰 예산 ${pct}% 도달 (${who})`,
    `${who}의 일일 토큰 사용량이 ${used.toLocaleString()} / ${cap.toLocaleString()} (${pct}%)에 도달했습니다.\n기준일(KST): ${day}\n임계치: ${Math.round(env.ALERT_COST_THRESHOLD * 100)}%`,
  );
}
