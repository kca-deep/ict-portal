import { getSupabaseAdmin } from "@/lib/db/supabase";
import { getJson } from "@/lib/law/client";

/**
 * law_cache 기반 법제처 응답 캐시 — 응답 속도 + 법제처 API 호출 한도 보호.
 *
 * best-effort: 캐시 조회/저장이 실패하더라도 무시하고 항상 본 호출로 진행한다.
 * (어드바이저가 캐시 장애로 멈춰선 안 된다.)
 */

// 캐시 키에서 OC(인증키)를 제거해 비밀이 DB 에 적재되지 않게 한다.
function cacheKey(toolName: string, url: string): string {
  let rest = url;
  try {
    const u = new URL(url);
    u.searchParams.delete("OC");
    rest = `${u.pathname}?${u.searchParams.toString()}`;
  } catch {
    // URL 파싱 실패 시 원문 사용 (best-effort)
  }
  return `${toolName}:${rest}`;
}

export async function cachedGetJson(
  url: string,
  toolName: string,
  ttlSeconds: number,
): Promise<unknown | null> {
  const key = cacheKey(toolName, url);

  // 1) 캐시 조회 (만료 전 항목만)
  try {
    const { data } = await getSupabaseAdmin()
      .from("law_cache")
      .select("payload")
      .eq("cache_key", key)
      .gt("ttl_at", new Date().toISOString())
      .maybeSingle();
    if (data?.payload != null) return data.payload;
  } catch {
    // 캐시 조회 실패 → 본 호출로 폴백
  }

  // 2) 본 호출 (법제처)
  const payload = await getJson(url);
  if (payload == null) return null;

  // 3) 캐시 저장 (실패 무시)
  try {
    const ttlAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await getSupabaseAdmin()
      .from("law_cache")
      .upsert(
        { cache_key: key, tool_name: toolName, payload, ttl_at: ttlAt },
        { onConflict: "cache_key" },
      );
  } catch {
    // 저장 실패 무시
  }

  return payload;
}
