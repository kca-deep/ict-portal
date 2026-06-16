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
};

export default nextConfig;
