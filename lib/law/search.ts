import { env } from "@/lib/env";
import { expandLawAbbreviation } from "@/lib/law/abbreviations";
import { buildSearchUrl, buildServiceUrl } from "@/lib/law/client";
import { cachedGetJson } from "@/lib/law/cache";
import { rerank } from "@/lib/ai/rerank";

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
  score?: number; // 관련도(0~1) — aiSearch 의미 랭킹 환산. 참조문서 표시용.
};

export type LawLookup = {
  refs: LawRef[];
  context: string; // LLM <context> 주입용 텍스트 (법령명 + 발췌 조문)
  articles: string[]; // 1위 법령의 발췌 조문 (참조문서 패널 표시용)
};

const LAW_NAME_RE =
  /[가-힣A-Za-z0-9·()]+(?:법률|시행령|시행규칙|법|규정|규칙|조례)/g;

// 출처: chrisryugj/korean-law-mcp (MIT) src/lib/law-search.ts NON_LAW_NAME_RE 이식 + 대화체 필러 추가.
// 법령'명'이 아닌 행위·절차·결과어와 대화 필러를 제거해 aiSearch/재정렬 query를 정제한다.
// 개념 토큰(기업회생·육아휴직 등)은 보존한다.
const NON_LAW_NAME_RE =
  /\s*(과태료|절차|비용|처벌|기준|허가|신청|부과|근거|위반|방법|요건|조건|처분|수수료|신고|등록|면허|인가|승인|취소|정지|벌칙|벌금|과징금|이행강제금|시정명령|체계|구조|판례|해석|개정|별표|서식|반환|납부|감면|면제|제한|금지|의무|권리|자격|종류|기간|대상|범위|적용|감경|영향|분석|위임|현황|처리|민원|매뉴얼|업무|담당|내용|알려|알려줘|진행|관련|어떻게|무엇|뭐|싶|해야|하는)\s*/g;

// 자연어 질의를 법령 검색어로 정제. 과잉 제거 시 원문으로 폴백.
export function distillLawQuery(query: string): string {
  const stripped = query.replace(NON_LAW_NAME_RE, " ").replace(/\s+/g, " ").trim();
  return stripped.length >= 2 ? stripped : query;
}

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

// 조문단위 한 건을 사람이 읽는 본문으로 재구성한다. get_law_text 는 머리글(조문내용)과
// 항/호/목을 구조 분리해 주므로(aiSearch 의 평문 조문내용과 다름) 문서 순서대로 합친다.
// (제54조: 조문내용="제54조(휴게)" + 항내용 "①…","②…" / 제110조: 조문내용=리드문 + 호내용)
function buildArticleText(a: any): string {
  const out: string[] = [];
  const push = (v: unknown) => {
    const s = String(v ?? "").trim();
    if (s) out.push(s);
  };
  const asArr = (v: unknown): any[] => (Array.isArray(v) ? v : v ? [v] : []);
  push(a?.["조문내용"]);
  for (const h of asArr(a?.["항"])) {
    push(h?.["항내용"]);
    for (const ho of asArr(h?.["호"])) {
      push(ho?.["호내용"]);
      for (const mok of asArr(ho?.["목"])) push(mok?.["목내용"]);
    }
  }
  return out.join("\n");
}

// lawService.do — 법령ID로 본문 조회 후 조문키 → {제목, 본문} 맵을 구성.
// 조문키: "제15조" / "제401조의2"(가지번호 정규화). 장(章) 구분자(조문여부="전문")는
// 같은 조문번호를 공유하므로 제외하고, 실제 조문(조문여부="조문")만 싣는다.
export async function fetchArticleMap(
  oc: string,
  lawId: string,
): Promise<Map<string, { title: string; body: string }>> {
  const json = (await cachedGetJson(
    buildServiceUrl({ oc, target: "law", id: lawId }),
    "get_law_text",
    TTL_TEXT,
  )) as any;
  const map = new Map<string, { title: string; body: string }>();
  if (!json) return map;
  const law = json.법령 ?? json.Law ?? Object.values(json)[0];
  const root = law?.조문?.조문단위 ?? law?.조문;
  const articles: any[] = Array.isArray(root) ? root : root ? [root] : [];
  for (const a of articles) {
    if (String(a?.["조문여부"] ?? "조문") !== "조문") continue;
    const no = String(a?.["조문번호"] ?? "").trim();
    if (!no || !/^\d+$/.test(no)) continue;
    const branchRaw = String(a?.["조문가지번호"] ?? "").trim();
    const branch =
      branchRaw && branchRaw !== "0" && branchRaw !== "00"
        ? String(parseInt(branchRaw, 10) || branchRaw)
        : "";
    const key = branch ? `제${no}조의${branch}` : `제${no}조`;
    if (map.has(key)) continue;
    map.set(key, {
      title: String(a?.["조문제목"] ?? "").trim(),
      body: buildArticleText(a),
    });
  }
  return map;
}

// 인용 검증용 실존 조문번호 집합 — 본문 맵의 키만 추린다.
export async function fetchArticleNumbers(
  oc: string,
  lawId: string,
): Promise<Set<string>> {
  return new Set((await fetchArticleMap(oc, lawId)).keys());
}

// 조문 라벨·제목·본문을 근거 패널 표시용 마크다운으로(searchAiLaw 카드와 동일 포맷).
export function formatArticle(
  articleLabel: string,
  title: string,
  body: string,
): string {
  const head = title ? `${articleLabel}(${title})` : articleLabel;
  return `**${head}**\n\n${clipText(cleanArticleBody(body), 800)}`;
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

// ── search_ai_law (본문 의미검색, 법제처 target=aiSearch) ────────────────────
// 법령 "이름"이 아니라 조문 "내용"으로 찾는다(법제처 MCP chrisryugj 의 search_ai_law
// 와 동명·동작). 법제처가 의미 랭킹을 수행하므로 한국 법 전체를 우리가 색인할 필요가
// 없다. 응답이 조문 단위(본문 내장)라 target=law 파서로는 못 읽어 전용 파서를 둔다
// (판례 파서 decisions.ts 의 방어적 패턴 차용).

// 여러 후보 키 중 처음 발견되는 비어있지 않은 값.
function pickField(o: any, keys: string[]): string {
  for (const k of keys) {
    const v = o?.[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}
const clipText = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max)} …` : s;

// 법제처 조문내용(평문 한 덩어리)을 근거 패널 표시용 마크다운으로 정리한다.
// (1) 본문 첫머리에 중복되는 "제○조(제목)" 접두를 떼고(헤더로 따로 볼드 처리하므로),
// (2) 항 기호(①②③…) 앞에 마크다운 하드 줄바꿈("  \n")을 넣어 항별로 한 줄씩
//     — 단락 간격 없이 촘촘하게 — 끊어 읽히게 한다(단일 개행은 마크다운에서 무시됨).
function cleanArticleBody(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(/^\s*제\s*\d+\s*조(?:의\s*\d+)?\s*(?:\([^)]*\))?\s*/, "")
    .replace(/\s*<[^>]*>/g, "") // <개정 2013.1.9>·<신설 …> 등 연혁 주석 제거(표시 노이즈)
    .replace(/[ \t]+/g, " ")
    .replace(/\s*([①-⑳])/g, "  \n$1") // 항 앞 마크다운 하드 줄바꿈
    .replace(/(?<!\d)\s*(\d{1,2})\.\s*(?=[가-힣])/g, "  \n$1. ") // 호(1. 2. …) 앞 줄바꿈
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type AiArticleHit = {
  lawId: string;
  name: string;
  articleNo: string;
  articleBranch: string; // 조문가지번호 ("00"=없음, "02"=제○조의2)
  articleTitle: string;
  body: string;
  promulgated: string;
};

// "0056"/"02" → "제56조의2" 형태로 정규화 (선행 0 제거, 가지번호 처리).
function fmtArticleNo(no: string, branch: string): string {
  const n = String(parseInt(no, 10) || no);
  const b =
    branch && branch !== "00" && branch !== "0"
      ? `의${parseInt(branch, 10) || branch}`
      : "";
  return `제${n}조${b}`;
}

// aiSearch 목록 파서 (순수 함수 — 네트워크 없이 픽스처로 단위검증 가능).
// 래퍼 키 `aiSearch`, 배열 키 `법령조문`, 법령명 `법령명`(target=law 의 `법령명한글`과 다름).
export function parseAiSearchList(json: any): AiArticleHit[] {
  if (!json) return [];
  const root = json.aiSearch ?? Object.values(json)[0];
  const list = root?.법령조문 ?? root?.law ?? [];
  const items = Array.isArray(list) ? list : [list].filter(Boolean);
  return items
    .map((it: any) => ({
      lawId: pickField(it, ["법령ID"]),
      name: pickField(it, ["법령명", "법령명한글"]),
      articleNo: pickField(it, ["조문번호"]),
      articleBranch: pickField(it, ["조문가지번호"]),
      articleTitle: pickField(it, ["조문제목"]),
      body: pickField(it, ["조문내용", "조문"]),
      promulgated: pickField(it, ["공포일자"]),
    }))
    .filter((a) => a.lawId && a.body);
}

// aiSearch 후보 조문을 Cohere 로 질의 기준 재정렬. 법제처 의미검색은 곁가지
// 법령을 위로 낼 수 있어(예: "야근수당"→지방공무원 수당규정), 내부 규정과 동일한
// 잣대(rerank-v3.5)로 다시 매겨 엉뚱한 법령을 끌어내린다. 실패 시 법제처 순서 유지.
async function rerankAiHits(
  query: string,
  hits: AiArticleHit[],
): Promise<{ hit: AiArticleHit; score: number }[]> {
  const fallback = hits.map((h, i) => ({
    hit: h,
    score: Number((1 - i / hits.length).toFixed(3)),
  }));
  try {
    const reranked = await rerank(
      query,
      hits.map((h, i) => ({
        id: i,
        text: `${h.name} ${h.articleTitle}\n${h.body}`,
      })),
      hits.length,
    );
    if (reranked.length === 0) return fallback;
    return reranked.map((r) => ({
      hit: hits[r.id as number],
      score: r.score,
    }));
  } catch (err) {
    console.error(
      "[law] aiSearch rerank 실패 — 법제처 순서 유지:",
      (err as Error).message,
    );
    return fallback;
  }
}

/**
 * search_ai_law — 본문 의미검색. 자연어 질의를 법제처 target=aiSearch(search=0,
 * 조문)로 보내 관련 조문을 받은 뒤, Cohere 재정렬로 질의-조문 실관련도를 매겨
 * 참조문서 관련도(LawRef.score)로 쓴다. 조문 본문이 응답에 내장되어 2차 본문
 * 호출(get_law_text) 없이 근거를 구성한다.
 *
 * 같은 법령에서 1위 조문만 쓰면 답변이 인용한 조문과 어긋날 수 있어(예: 근로기준법
 * 1위가 제54조 휴게인데 답변은 제56조 가산수당), 법령당 상위 articlesPerLaw 개
 * 조문을 함께 싣는다. articles[i] ↔ refs[i] 1:1 정렬 유지.
 *
 * 어드바이저 ①에서 내부 규정 관련도가 기준치 미만일 때 route 가 직접 호출한다.
 * 반환 계약은 searchLaw 와 동일(LawLookup)이라 route·verify 흐름은 그대로 작동.
 */
export async function searchAiLaw(
  query: string,
  display = 50,
  maxLaws = 3,
  articlesPerLaw = 3,
  minScore = 0.02,
): Promise<LawLookup> {
  const oc = env.LAW_GO_KR_API_KEY;
  if (!oc || !query.trim()) return { refs: [], context: "", articles: [] };

  // 자연어 원문을 법령 검색어로 정제(필러 제거) 후 약칭→정식명 확장.
  const distilled = expandLawAbbreviation(distillLawQuery(query));

  const json = await cachedGetJson(
    buildSearchUrl({ oc, target: "aiSearch", query: distilled, display, search: 0 }),
    "search_ai_law",
    TTL_SEARCH,
  );
  const hits = parseAiSearchList(json);
  if (hits.length === 0) return { refs: [], context: "", articles: [] };

  // 질의 기준 재정렬(내림차순)도 정제 query로 — 필러가 곁가지 조문을 띄우는 것 방지.
  const ordered = await rerankAiHits(distilled, hits);
  if (ordered.length === 0 || ordered[0].score < minScore) {
    // 최상위조차 무관 → 엉뚱한 법령 노출 방지차 빈 결과.
    return { refs: [], context: "", articles: [] };
  }

  type Group = { ref: LawRef; arts: string[] };
  const groups = new Map<string, Group>();
  for (const { hit: h, score } of ordered) {
    let g = groups.get(h.lawId);
    if (!g) {
      if (groups.size >= maxLaws) continue; // 이미 충분한 법령 수집됨
      g = {
        ref: {
          name: h.name,
          lawId: h.lawId,
          promulgated: h.promulgated,
          score: Number(score.toFixed(3)), // 그 법령의 최상위(=대표) 관련도
        },
        arts: [],
      };
      groups.set(h.lawId, g);
    }
    if (g.arts.length >= articlesPerLaw) continue;
    const label = h.articleTitle
      ? `${fmtArticleNo(h.articleNo, h.articleBranch)}(${h.articleTitle})`
      : fmtArticleNo(h.articleNo, h.articleBranch);
    // 조문 제목은 볼드 헤더로, 본문은 항별 줄바꿈으로 — 패널에서 규정 문서처럼 보이게.
    g.arts.push(`**${label}**\n\n${clipText(cleanArticleBody(h.body), 500)}`);
  }

  const refs: LawRef[] = [];
  const articles: string[] = [];
  for (const g of groups.values()) {
    refs.push(g.ref);
    articles.push(g.arts.join("\n\n"));
  }
  console.log(
    `[law] aiSearch: 후보 ${hits.length}건 → 법령=[${refs
      .map((r) => `${r.name}(${Math.round((r.score ?? 0) * 100)}%)`)
      .join(", ")}]`,
  );

  const context = refs
    .map(
      (r, i) =>
        `${i + 1}. ${r.name} (법령ID ${r.lawId}, 관련도 ${Math.round(
          (r.score ?? 0) * 100,
        )}%)\n${articles[i]}`,
    )
    .join("\n\n");
  return { refs, context, articles };
}
