import { env } from "@/lib/env";
import {
  searchByName,
  fetchArticleNumbers,
  type LawRef,
} from "@/lib/law/search";
import { expandLawAbbreviation } from "@/lib/law/abbreviations";

/**
 * 인용 검증 — LLM 답변의 조문 인용이 법제처 DB에 실존하는지 교차 검증한다.
 *
 * 법령 분기 답변에서 Claude 가 "○○법 제N조" 형태로 근거를 인용할 때, 존재하지
 * 않는 조문(환각)을 잡아낸다. korean-law MCP 의 verify_citations 핵심 로직만 추려
 * 무의존성으로 직접 구현. 모든 외부 호출은 best-effort — 실패해도 예외를 던지지 않는다.
 */

export type CitationStatus = "verified" | "not_found" | "ambiguous";

export type CitationVerdict = {
  raw: string; // 원문 인용 ("개인정보 보호법 제15조")
  lawName: string; // 해석된 법령명
  article: string; // 정규화 조문 ("제15조", "제401조의2")
  status: CitationStatus;
  note?: string;
};

export type CitationCheck = {
  verdicts: CitationVerdict[];
  hasHallucination: boolean; // not_found 가 하나라도 있으면 true
};

// (법령명 | 같은 법 | 동법) + 제N조(의M). 항·호는 조 단위 검증이라 캡처만 하고 버린다.
// 법령명은 공백 포함 다어절을 허용("개인정보 보호법", "정보통신망 이용촉진 및 …")하되
// 쉼표·마침표·따옴표는 문자클래스에서 제외해 문장 경계를 넘지 않는다. 앞 단어가 섞이는
// 과포착은 resolveLaw 의 앞토큰 제거 재시도로 흡수한다.
const CITATION_RE =
  /(?<law>같은\s*법|동법|(?:[가-힣A-Za-z0-9·()]+\s+)*[가-힣A-Za-z0-9·()]*(?:법률|법|령|규칙|규정|조례))\s*제(?<no>\d+)조(?:의(?<branch>\d+))?/g;

type ParsedCitation = { raw: string; lawName: string; article: string };

// 답변 텍스트에서 인용을 추출. "같은 법/동법"은 직전 명시 법령에 바인딩한다.
function parseCitations(text: string): ParsedCitation[] {
  const out: ParsedCitation[] = [];
  const seen = new Set<string>();
  let currentLaw = "";

  for (const m of text.matchAll(CITATION_RE)) {
    const g = m.groups as { law: string; no: string; branch?: string };
    const lawToken = g.law.trim().replace(/\s+/g, " ");
    const isAnaphora = lawToken.replace(/\s+/g, "") === "같은법" || lawToken === "동법";

    if (!isAnaphora) currentLaw = expandLawAbbreviation(lawToken);
    if (!currentLaw) continue; // 직전 명시 법령 없이 "같은 법"만 나온 경우 스킵

    const article = g.branch ? `제${g.no}조의${g.branch}` : `제${g.no}조`;
    const key = `${currentLaw}|${article}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: m[0].replace(/\s+/g, " ").trim(), lawName: currentLaw, article });
  }
  return out;
}

// 법령명 → 대표 LawRef. 과포착(앞 단어 혼입) 대비 전체 → 앞 토큰 제거 순으로 재시도.
// 각 시도에서 정확매칭(공백 무시) 우선, 없으면 1위 부분매칭.
async function resolveLaw(
  oc: string,
  lawName: string,
): Promise<LawRef | null> {
  const tokens = lawName.split(/\s+/).filter(Boolean);
  const noSpace = (s: string) => s.replace(/\s+/g, "");
  for (let start = 0; start < Math.max(tokens.length, 1); start++) {
    const candidate = tokens.slice(start).join(" ") || lawName;
    const refs = await searchByName(oc, candidate, 5);
    if (refs.length > 0) {
      const exact = refs.find((r) => noSpace(r.name) === noSpace(candidate));
      return exact ?? refs[0];
    }
  }
  return null;
}

export async function verifyCitations(
  text: string,
  maxCitations = 15,
): Promise<CitationCheck> {
  const oc = env.LAW_GO_KR_API_KEY;
  const parsed = parseCitations(text).slice(0, maxCitations);
  if (!oc || parsed.length === 0) {
    return { verdicts: [], hasHallucination: false };
  }

  // 법령별 본문 조회·조문집합은 1회만 (동일 법령 다수 인용 시 중복 호출 방지).
  const lawCache = new Map<string, { ref: LawRef | null; articles: Set<string> }>();
  async function lawInfo(lawName: string) {
    const cached = lawCache.get(lawName);
    if (cached) return cached;
    const ref = await resolveLaw(oc!, lawName);
    const articles = ref
      ? await fetchArticleNumbers(oc!, ref.lawId)
      : new Set<string>();
    const info = { ref, articles };
    lawCache.set(lawName, info);
    return info;
  }

  const verdicts = await Promise.all(
    parsed.map(async (c): Promise<CitationVerdict> => {
      try {
        const { ref, articles } = await lawInfo(c.lawName);
        if (!ref) {
          return {
            ...c,
            status: "not_found",
            note: "법제처 DB에 해당 법령 없음 (법령명 오류 또는 미존재)",
          };
        }
        if (articles.has(c.article)) {
          return { ...c, lawName: ref.name, status: "verified" };
        }
        // 법령은 존재하나 해당 조문이 없음 → 환각 가능성.
        return {
          ...c,
          lawName: ref.name,
          status: articles.size === 0 ? "ambiguous" : "not_found",
          note:
            articles.size === 0
              ? "법령 본문 조회 실패 — 조문 존재 확인 불가"
              : `「${ref.name}」에 ${c.article} 없음`,
        };
      } catch {
        return { ...c, status: "ambiguous", note: "검증 중 오류" };
      }
    }),
  );

  return {
    verdicts,
    hasHallucination: verdicts.some((v) => v.status === "not_found"),
  };
}
