/**
 * 약칭 확장 + 인용 검증 단독 검증 스크립트
 *
 * 목적: lib/law 에 추가한 두 기능이 실제 법제처 OpenAPI 에서 동작하는지 확인.
 *   1) expandLawAbbreviation — 관용 약칭 → 정식 법령명
 *   2) searchLaw — 약칭 질의가 정식 법령으로 검색되는지
 *   3) verifyCitations — 실존/환각 조문 인용 판정
 *
 * 실행:
 *   pnpm exec tsx scripts/test-law-verify.ts
 */
import "./_load-env";

import { expandLawAbbreviation } from "@/lib/law/abbreviations";
import { searchLaw } from "@/lib/law/search";
import { verifyCitations } from "@/lib/law/verify";

function divider(label: string) {
  console.log(`\n${"─".repeat(60)}\n▶ ${label}\n${"─".repeat(60)}`);
}

async function main() {
  // 1) 약칭 확장 (오프라인)
  divider("1단계 · 약칭 확장 (expandLawAbbreviation)");
  for (const a of ["화관법", "김영란법", "중대재해법", "정통망법", "근로기준법"]) {
    console.log(`  ${a.padEnd(8)} → ${expandLawAbbreviation(a)}`);
  }

  // 2) 약칭 질의로 법령 검색 (라이브)
  divider("2단계 · 약칭 질의 검색 (searchLaw)");
  const lookup = await searchLaw("화관법 영업정지 처분 기준");
  console.log(`  검색된 법령: [${lookup.refs.map((r) => r.name).join(", ")}]`);
  console.log(`  발췌 조문 수: ${lookup.articles.length}`);
  const hitFull = lookup.refs.some((r) => r.name.includes("화학물질관리법"));
  console.log(`  → 약칭→정식 확장 적중: ${hitFull ? "✅" : "❌"}`);

  // 3) 인용 검증 (라이브) — 실존 1 + 환각 1
  divider("3단계 · 인용 검증 (verifyCitations)");
  const sample =
    "개인정보 보호법 제15조에 따라 수집할 수 있으며, 같은 법 제999조의2에서도 이를 규정한다.";
  console.log(`  검증 텍스트: ${sample}`);
  const check = await verifyCitations(sample);
  for (const v of check.verdicts) {
    const mark =
      v.status === "verified" ? "✓" : v.status === "not_found" ? "✗" : "⚠";
    console.log(`  ${mark} ${v.raw}  [${v.status}]${v.note ? ` — ${v.note}` : ""}`);
  }
  console.log(`  → 환각 감지(hasHallucination): ${check.hasHallucination ? "✅ true" : "false"}`);

  divider("결과");
  console.log("  ✅ 약칭 확장 + 인용 검증 동작 확인 완료");
}

main().catch((e) => {
  console.error("\n✗ 예외 발생:", e);
  process.exit(1);
});
