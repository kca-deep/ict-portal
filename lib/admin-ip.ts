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
