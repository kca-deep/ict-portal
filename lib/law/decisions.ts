import { env } from "@/lib/env";
import { buildSearchUrl, buildServiceUrl } from "@/lib/law/client";
import { cachedGetJson } from "@/lib/law/cache";

// 캐시 TTL: 판례 목록 24h, 판례 본문은 불변이라 7d.
const TTL_LIST = 24 * 3600;
const TTL_TEXT = 7 * 24 * 3600;

/**
 * search_decisions / get_decision_text — 판례·헌재결정 검색·본문 회수
 * (법제처 DRF target=prec(판례) / detc(헌재결정)).
 *
 * korean-law MCP 의 동명 도구를 우리 코드로 자체 구현. 전송(transport)은 법령과
 * 같은 lib/law/client.ts 를 쓰되, 판례는 본문 구조(판시사항·판결요지·참조조문·
 * 판례내용)가 조문과 달라 별도 파서를 둔다.
 *
 * 모든 외부 호출은 best-effort — 실패 시 빈 결과를 반환하고 예외를 던지지 않는다.
 */

export type DecisionDomain = "prec" | "detc"; // 판례 / 헌재결정

export type DecisionRef = {
  serial: string; // 판례일련번호(=본문 조회 ID)
  caseName: string; // 사건명
  caseNo: string; // 사건번호
  court: string; // 법원명/기관
  date: string; // 선고일자/종국일자
  domain: DecisionDomain;
};

export type DecisionText = {
  summary?: string; // 판시사항
  holding?: string; // 판결요지/결정요지
  refStatutes?: string; // 참조조문
  body?: string; // 판례내용(발췌)
};

// 여러 후보 키 중 처음 발견되는 비어있지 않은 값을 문자열로.
function pick(obj: any, keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

const clip = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max)} …` : s;

/**
 * 목록 응답 파서 (순수 함수 — 네트워크 없이 픽스처로 단위검증 가능).
 * 법제처 응답 래퍼 키가 데이터셋마다 달라(Prec/Detc/소문자 등) 방어적으로 탐색.
 */
export function parseDecisionList(
  json: any,
  domain: DecisionDomain,
): DecisionRef[] {
  if (!json) return [];
  const root = json.PrecSearch ?? json.DetcSearch ?? Object.values(json)[0];
  const list = root?.prec ?? root?.detc ?? root?.[domain] ?? [];
  const items = Array.isArray(list) ? list : [list].filter(Boolean);
  return items
    .map((it: any) => ({
      serial: pick(it, [
        "판례일련번호",
        "판례정보일련번호",
        "헌재결정례일련번호",
        "일련번호",
      ]),
      caseName: pick(it, ["사건명"]),
      caseNo: pick(it, ["사건번호"]),
      court: pick(it, ["법원명", "기관명", "재판기관"]),
      date: pick(it, ["선고일자", "종국일자", "결정일자"]),
      domain,
    }))
    .filter((r: DecisionRef) => r.serial && r.caseName);
}

// 본문 응답 파서 (순수 함수).
export function parseDecisionText(json: any): DecisionText {
  if (!json) return {};
  const root =
    json.PrecService ??
    json.DetcService ??
    json.판례 ??
    Object.values(json)[0] ??
    {};
  const summary = pick(root, ["판시사항"]);
  const holding = pick(root, ["판결요지", "결정요지"]);
  const refStatutes = pick(root, ["참조조문"]);
  const body = pick(root, ["판례내용", "결정문", "전문"]);
  return {
    summary: summary ? clip(summary, 500) : undefined,
    holding: holding ? clip(holding, 800) : undefined,
    refStatutes: refStatutes || undefined,
    body: body ? clip(body.replace(/\s+/g, " "), 800) : undefined,
  };
}

// lawSearch.do?target=prec|detc — 판례·헌재 목록 조회. search=2 로 본문까지 검색.
export async function searchDecisions(
  query: string,
  domain: DecisionDomain = "prec",
  display = 3,
): Promise<DecisionRef[]> {
  const oc = env.LAW_GO_KR_API_KEY;
  if (!oc || !query.trim()) return [];
  const json = await cachedGetJson(
    buildSearchUrl({ oc, target: domain, query, display, search: 2 }),
    "search_decisions",
    TTL_LIST,
  );
  return parseDecisionList(json, domain);
}

// lawService.do?target=prec|detc&ID= — 판례·헌재 본문 회수.
export async function getDecisionText(
  serial: string,
  domain: DecisionDomain = "prec",
): Promise<DecisionText> {
  const oc = env.LAW_GO_KR_API_KEY;
  if (!oc || !serial) return {};
  const json = await cachedGetJson(
    buildServiceUrl({ oc, target: domain, id: serial }),
    "get_decision_text",
    TTL_TEXT,
  );
  return parseDecisionText(json);
}
