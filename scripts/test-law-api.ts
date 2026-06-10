/**
 * 법제처 국가법령정보 공동활용 OpenAPI 연결 테스트
 *
 * 목적: korean-law 기능 개발 전, .env.local 의 LAW_* 키로
 *       법제처 OpenAPI 가 실제로 응답하는지 단독 검증한다.
 *
 * 실행:
 *   pnpm exec tsx scripts/test-law-api.ts "검색어"
 *   pnpm exec tsx scripts/test-law-api.ts "개인정보 보호법"
 *   pnpm exec tsx scripts/test-law-api.ts "산업기술혁신 촉진법" --target=law
 *
 * 사용 키 (.env.local):
 *   LAW_GO_KR_API_KEY   → OpenAPI 의 OC(기관/이메일 ID) 값
 *   LAW_GO_KR_BASE_URL  → lawSearch.do (목록 조회) 엔드포인트
 */
import "./_load-env";

const OC = process.env.LAW_GO_KR_API_KEY;
const SEARCH_URL =
  process.env.LAW_GO_KR_BASE_URL ?? "https://www.law.go.kr/DRF/lawSearch.do";
// 본문 조회는 lawSearch.do → lawService.do 로 치환
const SERVICE_URL = SEARCH_URL.replace("lawSearch.do", "lawService.do");

// CLI 인자 파싱
const args = process.argv.slice(2);
const query = args.find((a) => !a.startsWith("--")) ?? "개인정보 보호법";
const target =
  args.find((a) => a.startsWith("--target="))?.split("=")[1] ?? "law";
// --grep="키워드" 지정 시, 본문 조문 중 해당 키워드를 포함한 조문 전문을 출력
const grepTerm = args.find((a) => a.startsWith("--grep="))?.split("=")[1];

function divider(label: string) {
  console.log(`\n${"─".repeat(60)}\n▶ ${label}\n${"─".repeat(60)}`);
}

async function callApi(url: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const full = `${url}?${qs}`;
  console.log(`  GET ${full}`);
  const res = await fetch(full, {
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get("content-type"), text };
}

async function main() {
  divider("환경 점검");
  if (!OC) {
    console.error("✗ LAW_GO_KR_API_KEY (OC) 가 비어 있습니다. .env.local 확인 필요.");
    process.exit(1);
  }
  console.log(`  OC(API key)   : ${OC}`);
  console.log(`  검색 엔드포인트: ${SEARCH_URL}`);
  console.log(`  본문 엔드포인트: ${SERVICE_URL}`);
  console.log(`  질의(query)   : "${query}"`);
  console.log(`  대상(target)  : ${target}`);

  // 1) 목록 조회
  divider("1단계 · 목록 조회 (lawSearch.do)");
  const search = await callApi(SEARCH_URL, {
    OC,
    target,
    type: "JSON",
    query,
    display: "5",
  });
  console.log(`  HTTP ${search.status} · content-type: ${search.contentType}`);

  let parsed: any;
  try {
    parsed = JSON.parse(search.text);
  } catch {
    console.error("  ✗ JSON 파싱 실패 — 응답 앞부분:");
    console.error("  " + search.text.slice(0, 400).replace(/\n/g, "\n  "));
    console.error(
      "\n  ⚠ 보통 OC 값이 미등록/오류일 때 HTML 안내 페이지가 반환됩니다.",
    );
    process.exit(1);
  }

  // 응답 루트 키는 target 에 따라 다름 (law, prec, admrul ...)
  const root = parsed.LawSearch ?? parsed.PrecSearch ?? Object.values(parsed)[0];
  const totalCnt = root?.totalCnt ?? "?";
  const list =
    root?.law ?? root?.prec ?? root?.admrul ?? root?.[target] ?? [];
  const items = Array.isArray(list) ? list : [list].filter(Boolean);

  console.log(`  ✓ 총 검색건수(totalCnt): ${totalCnt}`);
  console.log(`  ✓ 수신 항목: ${items.length}건`);

  if (items.length === 0) {
    console.warn("  ⚠ 결과 0건 — 질의어를 바꿔 다시 시도해 보세요.");
    return;
  }

  items.slice(0, 5).forEach((it: any, i: number) => {
    const name = it["법령명한글"] ?? it["사건명"] ?? it["행정규칙명"] ?? "(명칭 없음)";
    const id = it["법령ID"] ?? it["판례일련번호"] ?? it["법령일련번호"] ?? "?";
    const date = it["공포일자"] ?? it["선고일자"] ?? "";
    console.log(`    [${i + 1}] ${name}  (ID:${id}${date ? ` · ${date}` : ""})`);
  });

  // 2) 본문 조회 — 첫 결과의 법령 ID 로
  if (target === "law") {
    const first = items[0];
    const lawId = first["법령ID"];
    const mst = first["법령일련번호"];
    if (lawId || mst) {
      divider("2단계 · 본문 조회 (lawService.do)");
      const detail = await callApi(SERVICE_URL, {
        OC: OC!,
        target: "law",
        type: "JSON",
        ...(lawId ? { ID: String(lawId) } : { MST: String(mst) }),
      });
      console.log(`  HTTP ${detail.status} · content-type: ${detail.contentType}`);
      try {
        const dj = JSON.parse(detail.text);
        const law = dj.법령 ?? dj.Law ?? Object.values(dj)[0];
        const basic = law?.기본정보 ?? law;
        const title = basic?.법령명_한글 ?? basic?.법령명한글 ?? "(확인 불가)";
        const articleRoot = law?.조문?.조문단위 ?? law?.조문;
        const articles = Array.isArray(articleRoot) ? articleRoot : articleRoot ? [articleRoot] : [];
        console.log(`  ✓ 본문 수신: "${title}" · 조문 ${articles.length}개 파싱`);

        // --grep 키워드 매칭 조문 전문 출력
        if (grepTerm) {
          const flat = (v: any): string =>
            v == null ? "" : Array.isArray(v) ? v.map(flat).join("\n") : typeof v === "object" ? Object.values(v).map(flat).join("\n") : String(v);
          const hits = articles.filter((a) => flat(a).includes(grepTerm));
          console.log(`\n  🔎 "${grepTerm}" 포함 조문: ${hits.length}개`);
          hits.forEach((a: any) => {
            const no = a["조문번호"] ?? "";
            const title2 = a["조문제목"] ?? "";
            console.log(`\n  ── 제${no}조 ${title2 ? `(${title2})` : ""} ──`);
            console.log("  " + flat(a["조문내용"]).replace(/\n/g, "\n  "));
            const subs = a["항"];
            if (subs) {
              (Array.isArray(subs) ? subs : [subs]).forEach((s: any) => {
                console.log("  " + flat(s["항내용"] ?? s).replace(/\n/g, "\n  "));
              });
            }
          });
        }
      } catch {
        console.error("  ✗ 본문 JSON 파싱 실패 — 응답 앞부분:");
        console.error("  " + detail.text.slice(0, 400).replace(/\n/g, "\n  "));
      }
    }
  }

  divider("결과");
  console.log("  ✅ 법제처 OpenAPI 연결 성공 — 키/엔드포인트 정상 동작");
}

main().catch((e) => {
  console.error("\n✗ 예외 발생:", e);
  process.exit(1);
});
