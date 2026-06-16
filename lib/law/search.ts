import { env } from "@/lib/env";
import { expandLawAbbreviation } from "@/lib/law/abbreviations";
import { buildSearchUrl, buildServiceUrl } from "@/lib/law/client";
import { cachedGetJson } from "@/lib/law/cache";

// 캐시 TTL: 법령 목록 6h, 법령 본문(조문)은 변동이 드물어 24h.
const TTL_SEARCH = 6 * 3600;
const TTL_TEXT = 24 * 3600;

/**
 * search_law / get_law_text — 법령 검색·조문 회수 (법제처 DRF target=law).
 *
 * korean-law MCP 의 동명 도구를 우리 코드로 자체 구현. 전송(transport)은
 * lib/law/client.ts 가 담당하고, 이 파일은 법령 도메인 로직(법령명 추출·조문
 * 발췌·매칭)만 다룬다.
 *
 * 어드바이저 ①의 관련도 분기에서 내부 규정 관련도가 기준치(RELEVANCE_THRESHOLD)
 * 미만일 때 호출된다. 자연어 질의를 그대로 넘기면 법제처는 0건을 반환하므로
 * (lawSearch.do 는 법령명 기준 검색), 질의에서 법령명을 먼저 추출한다.
 *
 * 모든 외부 호출은 best-effort — 실패해도 빈 결과를 반환하고 예외를 던지지 않는다.
 * (route 가 법령 없이도 내부 규정만으로 계속 진행할 수 있어야 한다.)
 */

export type LawRef = {
  name: string; // 법령명한글
  lawId: string; // 법령ID
  promulgated: string; // 공포일자(YYYYMMDD)
  ministry?: string; // 소관부처명
  status?: string; // 현행연혁코드 ("현행" / "연혁")
};

export type LawLookup = {
  refs: LawRef[];
  context: string; // LLM <context> 주입용 텍스트 (법령명 + 발췌 조문)
  articles: string[]; // 1위 법령의 발췌 조문 (참조문서 패널 표시용)
};

const LAW_NAME_RE =
  /[가-힣A-Za-z0-9·()]+(?:법률|시행령|시행규칙|법|규정|규칙|조례)/g;

// 질의에서 법령명 후보를 추출 ("근로기준법 연차" → ["근로기준법"]).
function extractLawNames(query: string): string[] {
  const found = query.match(LAW_NAME_RE) ?? [];
  // 길이 3 미만(예: "방법"의 오탐 등)은 제외, 중복 제거.
  return [...new Set(found)].filter((s) => s.length >= 3);
}

// 법령명을 뺀 잔여 키워드 ("근로기준법 연차유급휴가 며칠" → ["연차유급휴가","며칠"]).
function residualKeywords(query: string, lawNames: string[]): string[] {
  let rest = query;
  for (const n of lawNames) rest = rest.split(n).join(" ");
  return rest
    .split(/[\s,.·]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

// 조사·띄어쓰기 변이를 흡수해 조문 매칭률을 높인다.
// ("연차유급휴가는" → "연차유급휴가", 본문 "연차 유급휴가" → "연차유급휴가" 로 정규화)
const JOSA_RE = /(으로|에서|부터|까지|은|는|이|가|을|를|에|의|도|만|과|와|로|상)$/;
const norm = (s: string) => s.replace(/\s+/g, "");
function keyVariants(k: string): string[] {
  const base = norm(k);
  const stripped = base.replace(JOSA_RE, "");
  return stripped.length >= 2 && stripped !== base ? [base, stripped] : [base];
}

// JSON 값(문자열/배열/객체)을 평문으로 펼침 — 조문 매칭·출력용.
function flatten(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(flatten).join("\n");
  if (typeof v === "object") return Object.values(v).map(flatten).join("\n");
  return String(v);
}

// lawSearch.do — 법령명으로 목록 조회.
export async function searchByName(
  oc: string,
  term: string,
  display: number,
): Promise<LawRef[]> {
  const json = (await cachedGetJson(
    buildSearchUrl({ oc, target: "law", query: term, display }),
    "search_law",
    TTL_SEARCH,
  )) as any;
  if (!json) return [];
  const root = json.LawSearch ?? Object.values(json)[0];
  const list = root?.law ?? [];
  const items = Array.isArray(list) ? list : [list].filter(Boolean);
  return items
    .map((it: any) => ({
      name: String(it["법령명한글"] ?? "").trim(),
      lawId: String(it["법령ID"] ?? ""),
      promulgated: String(it["공포일자"] ?? ""),
      ministry: it["소관부처명"] ? String(it["소관부처명"]) : undefined,
      status: it["현행연혁코드"] ? String(it["현행연혁코드"]).trim() : undefined,
    }))
    .filter((r: LawRef) => r.lawId);
}

// lawService.do — 법령ID로 본문 조회 후 잔여 키워드 매칭 조문만 발췌.
async function fetchArticles(
  oc: string,
  lawId: string,
  keywords: string[],
  maxArticles = 8,
  maxChars = 600,
): Promise<string[]> {
  const json = (await cachedGetJson(
    buildServiceUrl({ oc, target: "law", id: lawId }),
    "get_law_text",
    TTL_TEXT,
  )) as any;
  if (!json) return [];
  const law = json.법령 ?? json.Law ?? Object.values(json)[0];
  const root = law?.조문?.조문단위 ?? law?.조문;
  const articles: any[] = Array.isArray(root) ? root : root ? [root] : [];

  const scored = articles
    .map((a) => {
      const text = flatten(a);
      return { text, normText: norm(text) };
    })
    .filter((x) => x.text.trim().length > 0);

  // 키워드가 있으면 매칭 조문 우선(조사·띄어쓰기 정규화), 없으면 앞쪽 조문.
  const variants = keywords.flatMap(keyVariants);
  const picked =
    variants.length > 0
      ? scored.filter((x) => variants.some((v) => x.normText.includes(v)))
      : scored;
  const chosen = (picked.length > 0 ? picked : scored).slice(0, maxArticles);

  return chosen.map((x) => {
    const t = x.text.replace(/\s+\n/g, "\n").trim();
    return t.length > maxChars ? `${t.slice(0, maxChars)} …` : t;
  });
}

// lawService.do — 법령ID로 본문 조회 후 실존 조문번호 집합을 구성.
// 인용 검증용: "제15조" → "제15조", "제401조의2" → "제401조의2" 형태의 키 Set.
export async function fetchArticleNumbers(
  oc: string,
  lawId: string,
): Promise<Set<string>> {
  const json = (await cachedGetJson(
    buildServiceUrl({ oc, target: "law", id: lawId }),
    "get_law_text",
    TTL_TEXT,
  )) as any;
  const set = new Set<string>();
  if (!json) return set;
  const law = json.법령 ?? json.Law ?? Object.values(json)[0];
  const root = law?.조문?.조문단위 ?? law?.조문;
  const articles: any[] = Array.isArray(root) ? root : root ? [root] : [];
  for (const a of articles) {
    const no = String(a?.["조문번호"] ?? "").trim();
    if (!no || !/^\d+$/.test(no)) continue;
    const branch = String(a?.["조문가지번호"] ?? "").trim();
    set.add(branch ? `제${no}조의${branch}` : `제${no}조`);
  }
  return set;
}

export async function searchLaw(
  query: string,
  display = 3,
): Promise<LawLookup> {
  const oc = env.LAW_GO_KR_API_KEY;
  if (!oc) return { refs: [], context: "", articles: [] };

  // 추출 법령명을 약칭 확장(관용 약칭 보강) 후 검색어로 사용.
  const lawNames = extractLawNames(query).map(expandLawAbbreviation);
  const terms = lawNames.length > 0 ? lawNames.slice(0, 2) : [query];
  console.log(
    `[law] 법제처 조회 시작: 추출 법령명=[${lawNames.join(", ")}] 검색어=[${terms.join(", ")}]`,
  );

  // 1) 법령명 목록 조회 (중복 법령ID 제거)
  const seen = new Set<string>();
  const refs: LawRef[] = [];
  for (const term of terms) {
    for (const r of await searchByName(oc, term, display)) {
      if (seen.has(r.lawId)) continue;
      seen.add(r.lawId);
      refs.push(r);
    }
  }
  console.log(`[law] 법제처 조회 결과: laws=[${refs.map((r) => r.name).join(", ")}]`);
  if (refs.length === 0) return { refs: [], context: "", articles: [] };

  // 2) 1위 법령 본문에서 잔여 키워드 매칭 조문 발췌 (환각 방지용 실제 조문)
  const keywords = residualKeywords(query, lawNames);
  const articles = await fetchArticles(oc, refs[0].lawId, keywords);

  // 3) LLM 컨텍스트 구성
  const header = refs
    .map(
      (r, i) =>
        `${i + 1}. ${r.name} (법령ID ${r.lawId}, 공포 ${r.promulgated}${
          r.ministry ? `, 소관 ${r.ministry}` : ""
        })`,
    )
    .join("\n");
  const body =
    articles.length > 0
      ? `\n\n[${refs[0].name} 관련 조문 발췌]\n${articles.join("\n\n")}`
      : "";

  return { refs, context: `${header}${body}`, articles };
}
