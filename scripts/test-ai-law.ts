/**
 * search_ai_law(본문 의미검색) 라이브 진단 스크립트.
 *
 * 목적: 법제처 target=aiSearch 의 실제 응답 스키마를 눈으로 확인하고,
 *       우리 parseAiSearchList / fetchAiLawCandidates 가 0건이 아닌지 검증한다.
 *
 * 실행: pnpm exec tsx scripts/test-ai-law.ts "야근수당 안 주면 불법인가요?"
 */
import "./_load-env";

import { env } from "@/lib/env";
import { buildSearchUrl, getJson } from "@/lib/law/client";
import { parseAiSearchList, fetchAiLawCandidates, articleKeyOf } from "@/lib/law/search";

async function main() {
  const q = process.argv[2] ?? "야근수당 안 주면 불법인가요?";
  const oc = env.LAW_GO_KR_API_KEY;
  if (!oc) throw new Error("LAW_GO_KR_API_KEY 미설정");
  console.log(`▶ 질의: ${q}`);
  console.log(`▶ OC(앞4): ${oc.slice(0, 4)}…`);

  const url = buildSearchUrl({
    oc,
    target: "aiSearch",
    query: q,
    display: 5,
    search: 0,
  });
  console.log(`▶ URL: ${url.replace(oc, "***")}`);

  const raw = await getJson(url);
  console.log(`\n▶ 응답 최상위 키: ${raw ? Object.keys(raw).join(", ") : raw}`);
  console.log("▶ RAW(앞 2500자):");
  console.log(JSON.stringify(raw, null, 2).slice(0, 2500));

  const hits = parseAiSearchList(raw);
  console.log(`\n▶ parseAiSearchList 결과: ${hits.length}건`);
  console.log(hits.slice(0, 3));

  // 통합 파이프라인의 실제 공급 함수 — 원시 후보 + 인용 검증 재사용 맵.
  const cand = await fetchAiLawCandidates(q);
  console.log(`\n▶ fetchAiLawCandidates hits: ${cand.hits.length}건`);
  for (const h of cand.hits.slice(0, 10)) {
    console.log(`  · ${h.name} ${articleKeyOf(h)}${h.articleTitle ? `(${h.articleTitle})` : ""}`);
  }
  console.log(
    `▶ retrieved 맵: 법령 ${cand.retrieved.articles.size}종, ` +
      `조문 ${[...cand.retrieved.articles.values()].reduce((n, m) => n + m.size, 0)}건`,
  );
}

main().catch((e) => {
  console.error("\n✗ 예외:", e);
  process.exit(1);
});
