/**
 * 판례·헌재 파서 단위 검증 스크립트 (오프라인 — 픽스처 기반)
 *
 * 목적: lib/law/decisions.ts 의 순수 파서(parseDecisionList / parseDecisionText)가
 *   법제처 DRF 응답 형태를 올바로 해석하는지 네트워크 없이 검증한다.
 *   (라이브 호출은 LAW_GO_KR_API_KEY + 등록 IP 필요 — 별도 환경에서.)
 *
 * 실행:
 *   pnpm exec tsx scripts/test-law-decisions.ts
 */
import "./_load-env";

import {
  parseDecisionList,
  parseDecisionText,
} from "@/lib/law/decisions";

let failed = 0;
function assert(label: string, cond: boolean) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failed++;
}

function divider(label: string) {
  console.log(`\n${"─".repeat(60)}\n▶ ${label}\n${"─".repeat(60)}`);
}

// 법제처 판례 목록(target=prec) 응답 형태를 본뜬 픽스처.
const LIST_FIXTURE = {
  PrecSearch: {
    prec: [
      {
        판례일련번호: "228541",
        사건명: "손해배상(기)",
        사건번호: "2017다12345",
        법원명: "대법원",
        선고일자: "20180510",
      },
      {
        판례일련번호: "228999",
        사건명: "부당이득반환",
        사건번호: "2019다55555",
        법원명: "서울고등법원",
        선고일자: "20191120",
      },
    ],
  },
};

// 단건일 때 배열이 아닌 객체로 오는 경우(법제처 흔한 변형) 픽스처.
const LIST_SINGLE_FIXTURE = {
  PrecSearch: {
    prec: {
      판례일련번호: "300001",
      사건명: "위헌제청",
      사건번호: "2020헌가1",
      법원명: "헌법재판소",
      선고일자: "20210701",
    },
  },
};

const TEXT_FIXTURE = {
  PrecService: {
    판시사항: "불법행위로 인한 손해배상책임의 성립 요건",
    판결요지: "고의 또는 과실로 타인에게 손해를 가한 경우 배상책임이 있다.",
    참조조문: "민법 제750조",
    판례내용: "원고와   피고 사이의\n\n   분쟁에 관하여 …(중략)… 따라서 이를 인정한다.",
  },
};

async function main() {
  divider("1단계 · 목록 파서 (parseDecisionList) — 배열");
  const list = parseDecisionList(LIST_FIXTURE, "prec");
  assert("2건 파싱", list.length === 2);
  assert("serial 추출(228541)", list[0]?.serial === "228541");
  assert("caseName 추출", list[0]?.caseName === "손해배상(기)");
  assert("court 추출", list[0]?.court === "대법원");
  assert("domain 태깅(prec)", list[0]?.domain === "prec");

  divider("2단계 · 목록 파서 — 단건(객체) 변형");
  const single = parseDecisionList(LIST_SINGLE_FIXTURE, "detc");
  assert("1건 파싱", single.length === 1);
  assert("serial 추출(300001)", single[0]?.serial === "300001");
  assert("domain 태깅(detc)", single[0]?.domain === "detc");

  divider("3단계 · 본문 파서 (parseDecisionText)");
  const text = parseDecisionText(TEXT_FIXTURE);
  assert("판시사항", text.summary?.includes("손해배상책임") === true);
  assert("판결요지", text.holding?.includes("배상책임") === true);
  assert("참조조문", text.refStatutes === "민법 제750조");
  assert("판례내용 공백 정규화", text.body?.includes("원고와 피고") === true);

  divider("4단계 · 빈/이상 입력 방어");
  assert("null → 빈 배열", parseDecisionList(null, "prec").length === 0);
  assert("null → 빈 객체", Object.keys(parseDecisionText(null)).length === 0);

  divider("결과");
  if (failed === 0) {
    console.log("  ✅ 판례 파서 전체 통과");
  } else {
    console.log(`  ✗ 실패 ${failed}건`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\n✗ 예외 발생:", e);
  process.exit(1);
});
