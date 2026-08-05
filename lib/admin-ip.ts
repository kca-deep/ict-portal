// 관리자 표면(IP 허용목록) 검사 유틸 — 미들웨어 전용.
//
// 신뢰 가정: Vercel 이 앞단일 때 x-forwarded-for 의 첫 값은 엣지가 TCP 연결에서
// 직접 관측한 소스 IP 다(클라이언트가 실어 보낸 위조 값은 플랫폼이 제거). 기존
// 레이트리밋 IP 키와 동일한 값을 쓴다. Vercel 앞에 다른 CDN/프록시를 얹거나 타
// 플랫폼으로 이전하면 이 가정은 재검토 대상(신뢰 홉 수만큼 오른쪽에서 세야 함).
//
// 허용목록: 쉼표 구분 IPv4 단일("203.0.113.10") 또는 CIDR("203.0.113.0/29").
// IPv6 는 단일 정확 일치만 지원(기관 SSLVPN egress 는 IPv4 전제, PoC 범위).

/** x-forwarded-for 헤더에서 실제 접속자 IP(첫 값)를 뽑는다. */
export function clientIpFrom(xff: string | null): string | null {
  if (!xff) return null;
  const first = xff.split(",")[0]?.trim();
  return first || null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** 요청 호스트가 루프백인지(= 로컬에서 띄운 앱에 붙은 접속인지). */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * 허용목록 검사에 쓸 접속자 IP를 정한다.
 *
 * 로컬 프로덕션 스모크(`pnpm build && pnpm start`)에는 앞단 프록시가 없다. 이때
 * next start 가 x-forwarded-for 를 소켓 remoteAddress 로 직접 채우는데, 브라우저가
 * localhost 로 붙으면 그 값이 IPv6 루프백 "::1" 이라 ADMIN_ALLOWED_IPS 에 무엇을
 * 넣든 관리자 화면이 404 로 은닉됐다. 그래서 호스트가 루프백일 때만 루프백 표기
 * (::1 · ::ffff:127.0.0.1)를 127.0.0.1 로 정규화하고, 헤더 자체가 없어도 동일하게
 * 간주해 허용목록 검사에 태운다(허용 여부는 여전히 ADMIN_ALLOWED_IPS 가 결정).
 * Vercel 배포에서는 호스트가 실제 도메인이라 이 분기에 닿지 않는다.
 */
export function resolveClientIp(xff: string | null, hostname: string): string | null {
  const ip = clientIpFrom(xff);
  const loopbackHost = LOOPBACK_HOSTS.has(hostname);
  if (ip) return loopbackHost && LOOPBACK_IPS.has(ip) ? "127.0.0.1" : ip;
  return loopbackHost ? "127.0.0.1" : null;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function cidrContains(cidr: string, ip: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const baseInt = ipv4ToInt(base ?? "");
  const ipInt = ipv4ToInt(ip);
  if (baseInt == null || ipInt == null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (baseInt & mask) === (ipInt & mask);
}

/** ADMIN_ALLOWED_IPS 원문(쉼표 구분)을 파싱한다. 빈 문자열·공백은 버린다. */
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** ip 가 허용목록(단일 IP 또는 IPv4 CIDR)에 포함되는지. 목록이 비면 무조건 false(기본 거부). */
export function ipAllowed(ip: string | null, allowlist: string[]): boolean {
  if (!ip || allowlist.length === 0) return false;
  return allowlist.some((entry) => (entry.includes("/") ? cidrContains(entry, ip) : entry === ip));
}
