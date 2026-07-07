import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 시스템 프롬프트(prompts/*.md)는 fs로 동적 로드 — Vercel 서버리스 번들에
  // 동봉되도록 트레이싱에 명시 포함한다(미포함 시 런타임 ENOENT).
  outputFileTracingIncludes: {
    "/api/chat": ["./prompts/**"],
  },
  experimental: {
    serverActions: { bodySizeLimit: "4mb" },
  },
  // 전역 보안 헤더: 클릭재킹·MIME 스니핑 방지, Referrer 최소화, HTTPS 강제.
  // 관리자 쿠키·페이지 동작에는 영향이 없다(헤더는 쿠키를 건드리지 않음).
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
        ],
      },
    ];
  },
};

export default nextConfig;
