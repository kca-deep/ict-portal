import { CohereClient } from "cohere-ai";
import { env } from "@/lib/env";
import { addUsage } from "@/lib/usage/ledger";

const cohere = new CohereClient({ token: env.COHERE_API_KEY });

export type RerankCandidate = {
  id: string | number;
  text: string;
  metadata?: Record<string, unknown>;
};

export type RerankResult = RerankCandidate & { score: number };

export async function rerank(
  query: string,
  candidates: RerankCandidate[],
  topN: number = env.RERANK_TOP_K
): Promise<RerankResult[]> {
  if (candidates.length === 0) return [];
  const documents = candidates.map((c) => c.text);
  const response = await cohere.v2.rerank({
    model: env.RERANK_MODEL,
    query,
    documents,
    topN: Math.min(topN, candidates.length),
  });
  // Cohere 과금 단위(search unit) 계측 — meta 누락 시 호출 1회 = 1 unit 로 근사.
  addUsage({
    cohere_calls: 1,
    cohere_search_units: response.meta?.billedUnits?.searchUnits ?? 1,
  });
  return response.results.map((r) => ({
    ...candidates[r.index],
    score: r.relevanceScore,
  }));
}
