import { env } from "@/lib/env";
import {
  searchByName,
  fetchArticleMap,
  type LawRef,
  type RetrievedLaws,
} from "@/lib/law/search";
import { expandLawAbbreviation } from "@/lib/law/abbreviations";

/**
 * 인용 검증 — LLM 답변의 조문 인용이 법제처 DB에 실존하는지 교차 검증한다.
 *
 * 법령 분기 답변에서 Claude 가 "○○법 제N조" 형태로 근거를 인용할 때, 존재하지
 * 않는 조문(환각)을 잡아낸다. 추가로 조문이 실존하더라도 현행이 아닌(연혁·폐지)
 * 법령이면 currency 경고를 단다. korean-law MCP 의 legal_analysis(verify_citations)
 * 기능을 우리 코드로 자체 구현. 모든 외부 호출은 best-effort — 예외를 던지지 않는다.
 */

export type CitationStatus = "verified" | "not_found" | "ambiguous";

export type CitationVerdict = {
  raw: string; // 원문 인용 ("개인정보 보호법 제15조")
  lawName: string; // 해석된 법령명
  article: string; // 정규화 조문 ("제15조", "제401조의2")
  status: CitationStatus;
  note?: string;
  lawId?: string; // 검증된 법령ID (참조문서 본문 회수용)
  articleTitle?: string; // 조문 제목 ("벌칙")
  body?: string; // 조문 본문 (verified 인 경우만 — 인용 기준 참조 카드 표시용)
};

export type CitationCheck = {
  verdicts: CitationVerdict[];
  hasHallucination: boolean; // not_found 가 하나라도 있으면 true
};

// (법령명 | 같은 법[ 시행령/시행규칙] | 동법[ 시행령/시행규칙]) + 제N조(의M).
// 항·호는 조 단위 검증이라 캡처만 하고 버린다.
// 법령명은 공백 포함 다어절을 허용("개인정보 보호법", "정보통신망 이용촉진 및 …")하되
// 쉼표·마침표·따옴표는 문자클래스에서 제외해 문장 경계를 넘지 않는다. 앞 단어가 섞이는
// 과포착은 resolveLaw 의 앞토큰 제거 재시도로 흡수한다.
// 법령명 뒤에 닫는 낫표(」』】)·따옴표가 올 수 있다("「근로기준법」 제56조") — 조 앞에서 허용.
// 대용어는 "같은 법 시행령 제N조"처럼 시행령·시행규칙 접미사를 허용한다. 이 접미사가
// 일반 법령명 분기로 새서 "시행령" 한 단어로 축약되면 엉뚱한 시행령에 매칭되므로,
// 대용어 분기를 일반 분기보다 먼저 두어 직전 본법의 시행령으로 바인딩되게 한다.
const CITATION_RE =
  /(?<law>같은\s*법(?:\s*시행(?:령|규칙))?|동법(?:\s*시행(?:령|규칙))?|(?:[가-힣A-Za-z0-9·()]+\s+)*[가-힣A-Za-z0-9·()]*(?:법률|법|령|규칙|조례))\s*[」』】"']?\s*제(?<no>\d+)조(?:의(?<branch>\d+))?/g;

type ParsedCitation = { raw: string; lawName: string; article: string };

// 답변 텍스트에서 인용을 추출. "같은 법/동법[ 시행령/시행규칙]"은 직전 명시 법령에 바인딩한다.
function parseCitations(text: string): ParsedCitation[] {
  const out: ParsedCitation[] = [];
  const seen = new Set<string>();
  let currentLaw = ""; // 직전 명시 본법(또는 명시 법령) 전체명

  for (const m of text.matchAll(CITATION_RE)) {
    const g = m.groups as { law: string; no: string; branch?: string };
    const lawToken = g.law.trim().replace(/\s+/g, " ");
    // "같은 법/동법"(+ 선택적 시행령·시행규칙)을 대명사로 인식한다. 앞 단어가 함께
    // 과포착돼도(예: "위반한 사용자는 같은 법") 대명사로 본다. 일반 법령명이 "동법"으로
    // 끝나는 오인(예: "노동법")은 앞에 공백/문두 경계를 요구해 배제한다.
    const ana = lawToken.match(/(?:^|\s)(같은\s*법|동법)(?:\s*(시행령|시행규칙))?$/);

    let lawName: string;
    let displayLaw: string;
    if (ana) {
      if (!currentLaw) continue; // 직전 명시 법령 없이 대용어만 나온 경우 스킵
      const suffix = ana[2]; // "시행령" | "시행규칙" | undefined
      // "같은 법 시행령" = 직전 본법의 시행령. currentLaw 가 이미 시행령/시행규칙이면
      // 그 접미사를 떼고 다시 붙여 "… 시행령 시행령" 중복을 피한다.
      const baseAct = currentLaw.replace(/\s*시행(령|규칙)\s*$/, "");
      lawName = suffix ? `${baseAct} ${suffix}` : currentLaw;
      displayLaw = suffix ? `${ana[1]} ${suffix}` : ana[1];
    } else {
      currentLaw = expandLawAbbreviation(lawToken);
      if (!currentLaw) continue;
      lawName = currentLaw;
      displayLaw = lawToken;
    }

    const article = g.branch ? `제${g.no}조의${g.branch}` : `제${g.no}조`;
    const key = `${lawName}|${article}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const raw = `${displayLaw} ${article}`
      .replace(/[「」『』【】]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ raw, lawName, article });
  }
  return out;
}

// 한 단어로 축약되면 아무 법령이나 1순위로 매칭되는 일반어. 후보가 이로 축약되면
// 매칭을 거부해 엉뚱한 법령(예: "시행령" → 무관한 시행령) 주입을 막는다.
const GENERIC_LAW_TOKENS = new Set([
  "법", "법률", "령", "시행령", "시행규칙", "규칙", "규정", "조례", "같은", "동법",
]);

// 법령명 → 대표 LawRef. 과포착(앞 단어 혼입) 대비 전체 → 앞 토큰 제거 순으로 재시도.
// 각 시도에서 정확매칭(공백 무시) 우선, 없으면 후보명과 실제 관련된(포함관계) 1위.
async function resolveLaw(
  oc: string,
  lawName: string,
): Promise<LawRef | null> {
  const tokens = lawName.split(/\s+/).filter(Boolean);
  const noSpace = (s: string) => s.replace(/\s+/g, "");
  for (let start = 0; start < Math.max(tokens.length, 1); start++) {
    const candidate = (tokens.slice(start).join(" ") || lawName).trim();
    // 일반어 한 개로 축약된 후보는 변별력이 없어 거부(다음 시도도 더 짧아질 뿐이라 종료).
    if (GENERIC_LAW_TOKENS.has(candidate)) break;
    const cand = noSpace(candidate);
    const refs = await searchByName(oc, candidate, 5);
    const exact = refs.find((r) => noSpace(r.name) === cand);
    if (exact) return exact;
    // refs[0] 무조건 채택 금지 — 법제처 lawSearch.do 는 무매칭 질의에 무관한 기본
    // 목록을 반환할 때가 있어(예: "상법" → "1980년해직공무원…법" 1위), 그 junk 의
    // 1위를 그대로 쓰면 인용이 엉뚱한 법으로 둔갑한다(거짓 환각). 후보명과 포함관계가
    // 있는 후보만 채택하고, 없으면 다음 시도(앞토큰 제거)로 넘어가 결국 null 을 반환.
    const related = refs.find((r) => {
      const n = noSpace(r.name);
      return n.includes(cand) || cand.includes(n);
    });
    if (related) return related;
  }
  return null;
}

// 검색이 이미 회수한 조문에서 인용을 먼저 찾는다(법제처 재조회 회피). 정규화 법령명
// 정확매칭 우선, 없으면 포함매칭(답변이 약간 다른 표기로 인용한 경우). 조문키는 검색·
// 인용 모두 "제N조"/"제N조의M" 동일 포맷이라 그대로 대조. 표시 법령명은 인용 원문(c.lawName,
// 답변이 컨텍스트에서 그대로 가져온 정식명)을 그대로 쓴다.
function lookupRetrieved(
  retrieved: RetrievedLaws | undefined,
  lawName: string,
  article: string,
): { lawId: string; title: string; body: string } | null {
  if (!retrieved) return null;
  const key = lawName.replace(/\s+/g, "");
  let lawId = retrieved.nameToId.get(key);
  if (!lawId) {
    for (const [n, id] of retrieved.nameToId) {
      if (n.includes(key) || key.includes(n)) {
        lawId = id;
        break;
      }
    }
  }
  if (!lawId) return null;
  const art = retrieved.articles.get(lawId)?.get(article);
  return art ? { lawId, title: art.title, body: art.body } : null;
}

export async function verifyCitations(
  text: string,
  retrieved?: RetrievedLaws,
  maxCitations = 15,
): Promise<CitationCheck> {
  const oc = env.LAW_GO_KR_API_KEY;
  const parsed = parseCitations(text).slice(0, maxCitations);
  if (!oc || parsed.length === 0) {
    return { verdicts: [], hasHallucination: false };
  }

  // 법령별 본문 조회·조문맵은 1회만 (동일 법령 다수 인용 시 중복 호출 방지).
  type LawInfo = { ref: LawRef | null; map: Map<string, { title: string; body: string }> };
  const lawCache = new Map<string, LawInfo>();
  async function lawInfo(lawName: string): Promise<LawInfo> {
    const cached = lawCache.get(lawName);
    if (cached) return cached;
    const ref = await resolveLaw(oc!, lawName);
    const map = ref
      ? await fetchArticleMap(oc!, ref.lawId)
      : new Map<string, { title: string; body: string }>();
    const info: LawInfo = { ref, map };
    lawCache.set(lawName, info);
    return info;
  }

  const verdicts = await Promise.all(
    parsed.map(async (c): Promise<CitationVerdict> => {
      try {
        // 1) 검색이 이미 회수한 조문이면 법제처 재조회 없이 검증 완료(통합 핵심).
        //    aiSearch 본문은 법제처 공식 데이터라 실존이 이미 확인된 셈.
        const hit = lookupRetrieved(retrieved, c.lawName, c.article);
        if (hit) {
          return {
            ...c,
            status: "verified",
            lawId: hit.lawId,
            articleTitle: hit.title || undefined,
            body: hit.body,
          };
        }
        // 2) 검색에 없던 인용(모델 지식 인용 등) → 법제처 조회로 실존·환각 판정.
        const { ref, map } = await lawInfo(c.lawName);
        if (!ref) {
          // 법령명 자체를 해석 못함(법제처 조회 불일치). 이는 "실존 법의 없는 조문"(환각)과
          // 달라 not_found(환각)로 단정하지 않고 ambiguous(검증 보류)로 둔다 — 거짓 환각
          // 경고 방지. hasHallucination 은 not_found 만 트리거한다.
          return {
            ...c,
            status: "ambiguous",
            note: "법령명 해석 실패 — 검증 보류 (법제처 조회 불일치)",
          };
        }
        const found = map.get(c.article);
        if (found) {
          // 조문은 실존. 다만 현행이 아닌(연혁/폐지) 법령이면 currency 경고를 단다.
          const stale = Boolean(ref.status) && !ref.status!.includes("현행");
          return {
            ...c,
            lawName: ref.name,
            status: "verified",
            note: stale
              ? `연혁·폐지 법령일 수 있음 (현행연혁: ${ref.status}) — 현행 여부 확인 필요`
              : undefined,
            lawId: ref.lawId,
            articleTitle: found.title,
            body: found.body,
          };
        }
        // 법령은 존재하나 해당 조문이 없음 → 환각 가능성.
        return {
          ...c,
          lawName: ref.name,
          status: map.size === 0 ? "ambiguous" : "not_found",
          note:
            map.size === 0
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
