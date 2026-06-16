/**
 * 법제처 국가법령정보 공동활용 DRF OpenAPI 공통 클라이언트.
 *
 * korean-law MCP 서버에 런타임 연결하는 대신, 같은 기능을 우리 프로덕션 코드에
 * 자체 구현한다(Vercel 서버리스 친화 — 추가 인프라·외부 데이터전송 없음).
 *
 * 핵심: 법제처 DRF는 동일한 lawSearch.do(목록)/lawService.do(본문) 인프라에
 * `target` 파라미터만 바꿔 데이터셋을 전환한다. 이 계층이 그 전송(transport)을
 * 한곳에 모은다 — 법령(law)뿐 아니라 판례(prec)·헌재결정(detc)·법령해석례(expc)도
 * 같은 빌더로 호출할 수 있게 해, 추후 도구 확장 시 이 파일만 재사용한다.
 *
 * 모든 호출은 best-effort — 실패 시 null 을 반환하고 예외를 던지지 않는다.
 * (route 가 법령 없이도 내부 규정만으로 계속 진행할 수 있어야 한다.)
 */
import { env } from "@/lib/env";

export const SEARCH_URL =
  env.LAW_GO_KR_BASE_URL ?? "https://www.law.go.kr/DRF/lawSearch.do";
export const SERVICE_URL = SEARCH_URL.replace("lawSearch.do", "lawService.do");

// 법제처 DRF 데이터셋 구분. 현재는 법령(law)만 사용 — 판례(prec)·헌재(detc)·
// 해석례(expc)는 후속 도구에서 동일 빌더로 추가된다.
export type DrfTarget = "law" | "prec" | "detc" | "expc";

export async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}

// 목록 조회 URL (lawSearch.do). search=2 면 본문(판례 판시사항·내용 등)까지 검색.
export function buildSearchUrl(params: {
  oc: string;
  target: DrfTarget;
  query: string;
  display?: number;
  search?: 1 | 2;
}): string {
  const qs = new URLSearchParams({
    OC: params.oc,
    target: params.target,
    type: "JSON",
    query: params.query,
    display: String(params.display ?? 3),
  });
  if (params.search) qs.set("search", String(params.search));
  return `${SEARCH_URL}?${qs.toString()}`;
}

// 본문 조회 URL (lawService.do). 법령은 법령ID, 판례는 판례일련번호 등.
export function buildServiceUrl(params: {
  oc: string;
  target: DrfTarget;
  id: string;
}): string {
  const qs = new URLSearchParams({
    OC: params.oc,
    target: params.target,
    type: "JSON",
    ID: params.id,
  });
  return `${SERVICE_URL}?${qs.toString()}`;
}
