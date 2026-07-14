/**
 * 한국 공휴일 조회 — 공공데이터포털 한국천문연구원 특일 정보(getRestDeInfo).
 *
 * getRestDeInfo 는 "국경일 및 공휴일" 을 반환하며 isHoliday=Y 인 항목이 실제 쉬는 날이다.
 * 대체공휴일·임시공휴일·선거일도 정부 지정 시 이 데이터셋에 포함된다(요일/음력 계산으로는
 * 잡을 수 없는 값이라 공식 API 를 쓴다). 관리자 대시보드의 "쉬는 날 사용" 지표 판정에 쓴다.
 *
 * 결과는 연 단위로 거의 불변이라 모듈 메모리에 캐싱한다(Vercel Fluid Compute 인스턴스
 * 재사용). 실패·키 미설정 시 빈 집합을 반환해 대시보드가 깨지지 않게 한다(주말만 쉬는 날로
 * 폴백). best-effort — 예외를 던지지 않는다.
 */
import { env } from "@/lib/env";

// http 고정 — 이 게이트웨이는 https 로 호출 시 동일 키에도 401/403 을 반환하고 http 로만
// 200 을 준다(data.go.kr 특일정보의 알려진 특성). 공개 공휴일 데이터라 평문 전송 위험은 낮다.
const BASE_URL =
  "http://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo";

const OK_TTL_MS = 24 * 3600 * 1000; // 성공: 하루 캐싱(연 단위 데이터라 충분).
const FAIL_TTL_MS = 30 * 60 * 1000; // 실패: 30분 후 재시도(항상 두드리지 않도록).
const FETCH_TIMEOUT_MS = 5000;

type CacheEntry = { dates: Set<string>; expiresAt: number };
const cache = new Map<number, CacheEntry>();

// "YYYY-MM-DD"(KST) 공휴일 집합을 연도별로 반환. 키 미설정·실패 시 빈 집합.
export async function getKoreanHolidays(year: number): Promise<Set<string>> {
  const hit = cache.get(year);
  if (hit && hit.expiresAt > Date.now()) return hit.dates;

  const key = env.DATA_GO_KR_API_KEY;
  if (!key) {
    // 키가 없으면 폴백(주말만). 조용히 빈 집합을 캐싱해 반복 진입을 아낀다.
    const empty = new Set<string>();
    cache.set(year, { dates: empty, expiresAt: Date.now() + FAIL_TTL_MS });
    return empty;
  }

  const dates = await fetchHolidays(year, key);
  cache.set(year, {
    dates: dates ?? new Set(),
    expiresAt: Date.now() + (dates ? OK_TTL_MS : FAIL_TTL_MS),
  });
  return dates ?? new Set();
}

// 여러 연도의 공휴일을 한 번에 로드해 병합 없이 연도별 맵으로 돌려준다.
export async function getKoreanHolidaysForYears(
  years: number[],
): Promise<Map<number, Set<string>>> {
  const map = new Map<number, Set<string>>();
  await Promise.all(
    years.map(async (y) => {
      map.set(y, await getKoreanHolidays(y));
    }),
  );
  return map;
}

// 실제 API 호출. 성공 시 Set, 실패 시 null(호출부가 폴백·TTL 을 결정).
async function fetchHolidays(year: number, key: string): Promise<Set<string> | null> {
  const url = new URL(BASE_URL);
  // 디코딩(평문) 서비스키 기준 — URLSearchParams 가 한 번 인코딩한다.
  url.searchParams.set("serviceKey", key);
  url.searchParams.set("solYear", String(year));
  url.searchParams.set("numOfRows", "100"); // 1년 공휴일 < 100, 페이지네이션 불필요.
  url.searchParams.set("_type", "json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = JSON.parse(await res.text());
    return parseHolidayDates(json);
  } catch (err) {
    console.error("[holidays] fetch failed:", (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 응답에서 isHoliday=Y 인 locdate(YYYYMMDD 숫자)를 "YYYY-MM-DD" 로 뽑는다.
// item 은 결과가 1건이면 객체, 여러 건이면 배열, 0건이면 없음/빈문자열일 수 있다.
function parseHolidayDates(json: unknown): Set<string> {
  const dates = new Set<string>();
  const items = (json as any)?.response?.body?.items?.item;
  if (!items) return dates;
  const arr = Array.isArray(items) ? items : [items];
  for (const it of arr) {
    if (it?.isHoliday !== "Y") continue;
    const raw = String(it.locdate ?? "");
    if (raw.length === 8) {
      dates.add(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`);
    }
  }
  return dates;
}
