/**
 * 통합 리랭킹 진단 — route.ts 의 통합 파이프라인(규정+법령 단일 풀)을 그대로 재현한다.
 *
 * 목적: 특정 질의에서 규정 청크와 법령 조문이 한 풀에서 어떤 점수로 경쟁하고,
 *       top-K 주입분이 어떻게 섞이는지(규정/법령 비율·문턱 통과 여부)를 눈으로 본다.
 *
 * 실행: pnpm exec tsx scripts/test-route-decision.ts "야근수당 안 주면 불법인가요?"
 */
import "./_load-env";

import { env } from "@/lib/env";
import { regulationSearch } from "@/lib/db/search";
import { rerank } from "@/lib/ai/rerank";
import { fetchAiLawCandidates, articleKeyOf } from "@/lib/law/search";

async function main() {
  const query = process.argv[2] ?? "야근수당 안 주면 불법인가요?";
  console.log(`▶ 질의: ${query}`);
  console.log(
    `▶ RELEVANCE_THRESHOLD=${env.RELEVANCE_THRESHOLD} RERANK_TOP_K=${env.RERANK_TOP_K}`,
  );

  const [hits, lawCand] = await Promise.all([
    regulationSearch(query, env.RETRIEVAL_TOP_K),
    fetchAiLawCandidates(query),
  ]);
  console.log(`▶ 후보: 규정 ${hits.length}건 · 법령 조문 ${lawCand.hits.length}건`);

  // route.ts rerankUnifiedPool 과 동일한 풀 구성.
  const pool = [
    ...hits.map((h) => ({
      kind: "규정" as const,
      label: h.title ?? `(문서 ${h.id})`,
      text: h.content,
    })),
    ...lawCand.hits.map((h) => ({
      kind: "법령" as const,
      label: `${h.name} ${articleKeyOf(h)}${h.articleTitle ? `(${h.articleTitle})` : ""}`,
      text: `${h.name} ${h.articleTitle}\n${h.body}`,
    })),
  ];
  if (pool.length === 0) {
    console.log("▶ 후보 없음 — 종료");
    return;
  }

  const reranked = await rerank(
    query,
    pool.map((p, i) => ({ id: i, text: p.text })),
    env.RERANK_TOP_K,
  );

  const maxScore = reranked.length > 0 ? reranked[0].score : 0;
  const belowThreshold = maxScore < env.RELEVANCE_THRESHOLD;
  console.log(`\n▶ 통합 top-${env.RERANK_TOP_K}:`);
  for (const r of reranked) {
    const p = pool[r.id as number];
    const pass = r.score >= env.RELEVANCE_THRESHOLD;
    console.log(
      `  ${pass ? "✓주입" : "✗제외"} [${p.kind}] ${r.score.toFixed(3)}  ${p.label}`,
    );
  }
  console.log(
    `\n▶ maxScore=${maxScore.toFixed(3)} belowThreshold=${belowThreshold}` +
      (belowThreshold
        ? " → 근거 없음(범위 게이트로: 범위 내면 정직 무근거 답변 / 범위 밖이면 거절)"
        : " → unified 주입 진행"),
  );
}

main().catch((e) => {
  console.error("\n✗ 예외:", e);
  process.exit(1);
});
