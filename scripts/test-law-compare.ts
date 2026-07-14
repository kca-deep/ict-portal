/**
 * 우리 내부 fetchAiLawCandidates(aiSearch) 결과를 법제처 공식 원문
 * (lawService.do=get_law_text, korean-law-mcp 의 2번째 콜과 동일)과 대조해
 * 조문 본문 정확성을 검증한다.
 *
 * 검증: 우리 aiSearch 조문 본문이 공식 원문과 글자 단위로 일치하는지.
 * 실행: pnpm exec tsx scripts/test-law-compare.ts
 */
import "./_load-env";

import { env } from "@/lib/env";
import { buildServiceUrl, getJson } from "@/lib/law/client";
import { fetchAiLawCandidates, articleKeyOf } from "@/lib/law/search";

function flatten(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(flatten).join(" ");
  if (typeof v === "object") return Object.values(v).map(flatten).join(" ");
  return String(v);
}

// 법제처 공식 원문에서 특정 조문 본문을 회수 (= korean-law-mcp get_law_text).
async function officialArticle(
  lawId: string,
  no: number,
  branch: number,
): Promise<string | null> {
  const oc = env.LAW_GO_KR_API_KEY!;
  const json: any = await getJson(buildServiceUrl({ oc, target: "law", id: lawId }));
  if (!json) return null;
  const law = json.법령 ?? json.Law ?? Object.values(json)[0];
  const root = law?.조문?.조문단위 ?? law?.조문;
  const units: any[] = Array.isArray(root) ? root : root ? [root] : [];
  // 같은 조문번호를 장/절 머리글이 공유할 수 있어, 매칭 중 본문이 가장 긴 단위를 택한다.
  let best: string | null = null;
  for (const u of units) {
    const n = parseInt(String(u?.["조문번호"] ?? ""), 10);
    const b = parseInt(String(u?.["조문가지번호"] ?? "0"), 10) || 0;
    if (n !== no || b !== branch) continue;
    const t = flatten(u);
    if (best === null || t.length > best.length) best = t;
  }
  return best;
}

async function verifyQuery(query: string) {
  console.log(`\n${"═".repeat(72)}\n질의: "${query}"\n${"═".repeat(72)}`);
  const cand = await fetchAiLawCandidates(query);
  if (cand.hits.length === 0) {
    console.log("  (법령 후보 없음)");
    return;
  }

  // 후보 상위 6건만 대조(스크립트 실행 시간 제한).
  for (const h of cand.hits.slice(0, 6)) {
    const label = `${h.name} ${articleKeyOf(h)}${h.articleTitle ? `(${h.articleTitle})` : ""}`;
    const am = articleKeyOf(h).match(/제(\d+)조(?:의(\d+))?/);
    if (!am) continue;
    const no = parseInt(am[1], 10);
    const branch = am[2] ? parseInt(am[2], 10) : 0;
    const official = await officialArticle(h.lawId, no, branch);
    if (!official) {
      console.log(`   ${label} · 공식원문 회수 실패 ⚠`);
      continue;
    }
    // 한글·숫자만 남겨 구두점/메타데이터 차이를 제거하고 본문 식별 구절로 대조.
    const k = (s: string) => s.replace(/[^가-힣0-9]/g, "");
    const ourBodyNoTitle = h.body.replace(/^\s*제\d+조(?:의\d+)?\s*\([^)]*\)/, "");
    const probe = k(ourBodyNoTitle).slice(0, 30);
    const match = probe.length >= 12 && k(official).includes(probe);
    console.log(
      `   ${label}\n     → 원문 대조: ${match ? "✓ 일치(본문이 공식 원문에 그대로 존재)" : "✗ 불일치"} ` +
        `(우리 본문 ${h.body.length}자, 원문 ${official.length}자)`,
    );
    if (!match) {
      console.log(`     식별구절: ${probe}`);
      console.log(`     원문(한글만): ${k(official).slice(0, 80)}…`);
    }
  }
}

async function main() {
  for (const q of [
    "야근수당 안 주면 불법인가요?",
    "전세보증금 못 돌려받았어요",
    "직장 내 괴롭힘 신고하면 어떻게 되나요?",
  ]) {
    await verifyQuery(q);
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
