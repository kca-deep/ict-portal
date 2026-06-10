/**
 * RAG 우선 → 관련도 분기 → 법제처 폴백 라우팅 테스트
 *
 * 목적: app/api/chat/route.ts 의 실제 파이프라인(내부 규정 검색 → Cohere 재정렬)을
 *       그대로 재현해, "최대 관련도"가 기준치(기본 30%) 이상이면 내부 규정만으로,
 *       미만이면 법제처 OpenAPI(법령)로 폴백하는 분기를 단독 검증한다.
 *       ※ 기능 추가가 아니라 분기 동작 확인용 테스트 스크립트.
 *
 * 실행:
 *   pnpm exec tsx scripts/test-rag-routing.ts "연차휴가 며칠이야"
 *   pnpm exec tsx scripts/test-rag-routing.ts "공공저작물은 무료로 쓸 수 있나" --threshold=0.3
 *
 * 분기 기준: Cohere rerank 최상위 relevanceScore (0~1).
 *   ≥ threshold → 내부 규정(RAG) 근거만 사용, 법제처 호출 안 함
 *   < threshold → 법제처 lawSearch.do/lawService.do 폴백
 */
import "./_load-env";

import { regulationSearch } from "@/lib/db/search";
import { rerank } from "@/lib/ai/rerank";
import { env } from "@/lib/env";

const args = process.argv.slice(2);
const query = args.find((a) => !a.startsWith("--")) ?? "연차휴가 며칠이야";
// 기준치는 .env(RELEVANCE_THRESHOLD)에서 읽고, --threshold= 로만 일시 override
const threshold = Number(
  args.find((a) => a.startsWith("--threshold="))?.split("=")[1] ??
    env.RELEVANCE_THRESHOLD,
);
// --dump=N : 분기와 무관하게 재정렬 상위 N건의 본문 전문을 출력 (근거 확인용)
const dumpN = Number(args.find((a) => a.startsWith("--dump="))?.split("=")[1] ?? "0");

const OC = process.env.LAW_GO_KR_API_KEY;
const SEARCH_URL =
  process.env.LAW_GO_KR_BASE_URL ?? "https://www.law.go.kr/DRF/lawSearch.do";

function divider(label: string) {
  console.log(`\n${"─".repeat(64)}\n▶ ${label}\n${"─".repeat(64)}`);
}
const pct = (s: number) => `${(s * 100).toFixed(1)}%`;

// 법제처 폴백 — test-law-api.ts 에서 검증된 동일 호출 방식
async function lawFallback(q: string) {
  if (!OC) {
    console.error("  ✗ LAW_GO_KR_API_KEY(OC) 없음 — 폴백 불가");
    return;
  }
  const qs = new URLSearchParams({
    OC,
    target: "law",
    type: "JSON",
    query: q,
    display: "3",
  }).toString();
  const url = `${SEARCH_URL}?${qs}`;
  console.log(`  GET ${url}`);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("  ✗ 법제처 응답 JSON 파싱 실패:", text.slice(0, 200));
    return;
  }
  const root = parsed.LawSearch ?? Object.values(parsed)[0];
  const list = root?.law ?? [];
  const items = Array.isArray(list) ? list : [list].filter(Boolean);
  console.log(`  ✓ 법제처 검색 ${items.length}건 (totalCnt: ${root?.totalCnt ?? "?"})`);
  items.slice(0, 3).forEach((it: any, i: number) => {
    console.log(
      `    [${i + 1}] ${it["법령명한글"]}  (ID:${it["법령ID"]} · ${it["공포일자"] ?? ""})`,
    );
  });
}

async function main() {
  divider("설정");
  console.log(`  질의      : "${query}"`);
  console.log(`  분기 기준치: ${pct(threshold)} (rerank 최상위 relevanceScore 기준)`);
  console.log(`  검색 후보 : 최대 ${env.RETRIEVAL_TOP_K}건 → 재정렬 상위 ${env.RERANK_TOP_K}건`);

  // 1) 내부 규정 검색 (OpenAI 임베딩 + hybrid)
  divider("1단계 · 내부 규정 검색 (regulation_search)");
  const hits = await regulationSearch(query, env.RETRIEVAL_TOP_K);
  console.log(`  ✓ 후보 ${hits.length}건 수신`);
  if (hits.length === 0) {
    console.warn("  ⚠ 후보 0건 — 내부 규정 미색인이거나 무관한 질의");
  }

  // 2) Cohere 재정렬 → 관련도 산출
  divider("2단계 · 재정렬 (Cohere rerank-v3.5)");
  let reranked: { id: string | number; score: number; text: string }[] = [];
  let maxScore = 0;
  if (hits.length > 0) {
    reranked = await rerank(
      query,
      hits.map((h) => ({ id: h.id, text: h.content })),
      env.RERANK_TOP_K,
    );
    maxScore = reranked.length > 0 ? reranked[0].score : 0;
    const byId = new Map(hits.map((h) => [h.id, h]));
    reranked.slice(0, 5).forEach((r, i) => {
      const h = byId.get(r.id as number);
      const title = h?.title ?? h?.source_ref ?? `doc#${r.id}`;
      console.log(`    [${i + 1}] ${pct(r.score)}  ${title}`);
    });
  }
  console.log(`\n  ▶ 최대 관련도: ${pct(maxScore)}`);

  // (선택) 상위 N건 본문 덤프 — 분기와 무관하게 근거 확인용
  if (dumpN > 0 && reranked.length > 0) {
    divider(`참고 · 재정렬 상위 ${dumpN}건 본문`);
    const byId = new Map(hits.map((h) => [h.id, h]));
    reranked.slice(0, dumpN).forEach((r, i) => {
      const h = byId.get(r.id as number);
      if (!h) return;
      console.log(`\n  ── [${i + 1}] ${pct(r.score)} · ${h.title ?? h.source_ref ?? `doc#${h.id}`} ──`);
      console.log("  " + h.content.replace(/\n/g, "\n  "));
    });
  }

  // 3) 관련도 분기
  divider("3단계 · 관련도 분기");
  if (maxScore >= threshold) {
    console.log(`  ✅ ${pct(maxScore)} ≥ ${pct(threshold)} → 내부 규정(RAG)만 사용`);
    console.log("     (법제처 MCP 호출하지 않음)");
    const byId = new Map(hits.map((h) => [h.id, h]));
    const top = byId.get(reranked[0].id as number);
    if (top) {
      console.log(`\n  최상위 근거: ${top.title ?? top.source_ref ?? `doc#${top.id}`}`);
      console.log("  " + top.content.slice(0, 300).replace(/\n/g, "\n  ") + " …");
    }
  } else {
    console.log(`  ↪ ${pct(maxScore)} < ${pct(threshold)} → 내부 규정 부족, 법제처 폴백`);
    divider("4단계 · 법제처 폴백 (lawSearch.do)");
    await lawFallback(query);
  }

  divider("결과");
  console.log(
    `  분기: ${maxScore >= threshold ? "내부 규정(RAG)" : "법제처 법령"} · 최대 관련도 ${pct(maxScore)}`,
  );
}

main().catch((e) => {
  console.error("\n✗ 예외:", e);
  process.exit(1);
});
