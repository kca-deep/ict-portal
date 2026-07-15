import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

const nextConfig: NextConfig = {
  // 시스템 프롬프트(prompts/*.md)는 fs로 동적 로드 — Vercel 서버리스 번들에
  // 동봉되도록 트레이싱에 명시 포함한다(미포함 시 런타임 ENOENT).
  outputFileTracingIncludes: {
    "/api/chat": ["./prompts/**"],
  },
  experimental: {
    serverActions: { bodySizeLimit: "4mb" },
  },
  // 전역 정적 보안 헤더: 클릭재킹·MIME 스니핑 방지, Referrer 최소화, HTTPS 강제.
  // CSP 는 요청별 nonce 가 필요해 여기 두지 않고 middleware.ts 에서 발급한다.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

// BotID 클라이언트 보호 스크립트 주입 + 서버 검증 경로를 위해 설정을 래핑한다.
export default withBotId(nextConfig);
