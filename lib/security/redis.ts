import { Redis } from "@upstash/redis";
import { env } from "@/lib/env";

// 레이트리밋·비용가드의 공유 저장소. Upstash Redis(REST) — Vercel 서버리스에서
// 커넥션 없이 동작하고 원자적 INCR 을 제공한다. 미구성(로컬 등)이면 null 을 돌려
// 호출부가 정책(프로덕션 fail-closed / 로컬 통과)을 결정한다.
let client: Redis | null = null;

export type RedisClient = Redis;

/** Upstash Redis 싱글턴. 키가 없으면 null. */
export function getRedis(): Redis | null {
  if (client) return client;
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null;
  client = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
  return client;
}

/**
 * 일일 버킷 롤오버 경계를 KST(UTC+9) 자정에 맞춘 날짜키(YYYYMMDD).
 * 서버(UTC)에서 그대로 날짜를 뽑으면 한국 기준 9시간 어긋나므로 +9h 보정.
 */
export function kstDayKey(now: Date = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

// 일일 카운터 만료(초) — 경계 여유로 2일. 날짜키가 매일 바뀌므로 누수 없음.
export const DAILY_TTL_SEC = 2 * 24 * 3600;
