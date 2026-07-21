import { AsyncLocalStorage } from "node:async_hooks";

// 요청당 외부 API 사용량 원장. /api/chat 한 요청이 부르는 유료 API 는 답변 LLM 외에도
// OpenAI 임베딩(원질의+의도별) · Cohere 재정렬(통합+의도별+판례) · Anthropic 보조
// (의도 분해·범위 게이트) · 법제처 DRF 가 있는데, 종전엔 답변 LLM 토큰만 계측됐다.
// 이 원장이 그 나머지를 요청 스코프로 집계한다 — 비용가드 합산 + query_log.api_usage 적재.
//
// AsyncLocalStorage 를 쓰는 이유: 계측 지점이 lib/ai·lib/law 곳곳이라 파라미터로
// 관통시키면 호출부 시그니처가 전부 바뀐다. 전 라우트가 Node 런타임 고정이므로 ALS 가
// 안전하고, 원장이 없는 컨텍스트(ingest 의 embed 등)에서는 addUsage 가 no-op 이다.

export type ApiUsage = {
  openai_embed_calls: number;
  openai_embed_tokens: number;
  cohere_calls: number;
  cohere_search_units: number;
  anthropic_aux_calls: number; // 의도 분해 + 범위 게이트
  anthropic_aux_in: number;
  anthropic_aux_out: number;
  law_api_calls: number; // 법제처 DRF fetch 횟수(성공·실패 무관)
};

const als = new AsyncLocalStorage<ApiUsage>();

export function emptyUsage(): ApiUsage {
  return {
    openai_embed_calls: 0,
    openai_embed_tokens: 0,
    cohere_calls: 0,
    cohere_search_units: 0,
    anthropic_aux_calls: 0,
    anthropic_aux_in: 0,
    anthropic_aux_out: 0,
    law_api_calls: 0,
  };
}

/** usage 를 원장으로 삼아 fn 을 실행한다. fn 안(비동기 포함)의 addUsage 가 여기 누적된다. */
export function runWithUsage<T>(usage: ApiUsage, fn: () => Promise<T>): Promise<T> {
  return als.run(usage, fn);
}

/** 현재 요청 원장에 사용량을 더한다. 원장이 없는 컨텍스트면 조용히 무시(no-op). */
export function addUsage(patch: Partial<ApiUsage>): void {
  const u = als.getStore();
  if (!u) return;
  for (const k of Object.keys(patch) as (keyof ApiUsage)[]) {
    u[k] += patch[k] ?? 0;
  }
}
