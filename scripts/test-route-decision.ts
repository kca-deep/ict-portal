/**
 * 라우팅 분기 진단 — route.ts 의 "규정 vs 법령" 판정을 그대로 재현한다.
 *
 * 목적: 특정 질의가 법제처로 분기되는지(=규정 관련도 < 임계값 또는 게이트 NO)를
 *       실제 값으로 확인. UI 없이 maxScore / threshold / gate 를 눈으로 본다.
 *
 * 실행: pnpm exec tsx scripts/test-route-decision.ts "야근수당 안 주면 불법인가요?"
 */
import "./_load-env";

import { env } from "@/lib/env";
import { regulationSearch } from "@/lib/db/search";
import { rerank } from "@/lib/ai/rerank";
import { isRegulationSufficient } from "@/lib/ai/llm-router";

async function main() {
  const query = process.argv[2] ?? "야근수당 안 주면 불법인가요?";
  console.log(`▶ 질의: ${query}`);
  console.log(`▶ RELEVANCE_THRESHOLD(현재 로드값): ${env.RELEVANCE_THRESHOLD}`);

  const hits = await regulationSearch(query, env.RETRIEVAL_TOP_K);
  console.log(`▶ 규정 검색 후보: ${hits.length}건`);

  let maxScore = 0;
  if (hits.length > 0) {
    const reranked = await rerank(
      query,
      hits.map((h) => ({ id: h.id, text: h.content })),
      env.RERANK_TOP_K,
    );
    maxScore = reranked.length > 0 ? reranked[0].score : 0;
    console.log(
      `▶ 재정렬 상위: ${reranked
        .slice(0, 3)
        .map((r) => r.score.toFixed(3))
        .join(", ")}`,
    );
  }

  const belowThreshold = maxScore < env.RELEVANCE_THRESHOLD;
  let gateSufficient: boolean | null = null;
  if (!belowThreshold && hits.length > 0) {
    const docs = hits.slice(0, env.RERANK_TOP_K).map((h) => ({
      title: h.title,
      source_ref: h.source_ref,
      content: h.content,
      metadata: h.metadata,
    }));
    gateSufficient = await isRegulationSufficient(query, docs);
  }
  const routedToLaw = belowThreshold || gateSufficient === false;

  console.log(
    `\n▶ maxScore=${maxScore.toFixed(3)} threshold=${env.RELEVANCE_THRESHOLD} ` +
      `belowThreshold=${belowThreshold} gateSufficient=${gateSufficient}`,
  );
  console.log(
    `▶ 분기 결과: ${routedToLaw ? "⚖️ 법제처(law) — searchAiLaw 호출됨" : "📘 내부 규정(regulation) — 법제처 미호출"}`,
  );
}

main().catch((e) => {
  console.error("\n✗ 예외:", e);
  process.exit(1);
});
