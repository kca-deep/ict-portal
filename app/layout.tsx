import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { IBM_Plex_Sans_KR } from "next/font/google";
import { BotIdClient } from "botid/client";
import "./globals.css";
import "streamdown/styles.css";

// BotID 로 보호할 서버 경로 — 클라이언트가 이 경로로 보내는 요청에 봇 탐지 신호를
// 자동 첨부한다(각 라우트가 checkBotId 로 검증). chat 은 유료 LLM, feedback 은
// 무인증 쓰기(만족도 KPI 조작 방지).
const PROTECTED_ROUTES = [
  { path: "/api/chat", method: "POST" },
  { path: "/api/feedback", method: "POST" },
];

// 본문·디스플레이 공통 폰트: IBM Plex Sans KR(빌드 시 자체 호스팅).
// globals.css 의 --font-sans 가 이 로더 변수를 참조하고, --font-display 는
// 아래 <html> 에서 --font-sans 를 그대로 가리킨다(globals.css 에 폰트명 하드코딩 없음).
// 한글 글리프가 커 preload 는 끔(권장). weight 는 고정폭 계열(가변 아님)이라 명시.
const sans = IBM_Plex_Sans_KR({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-ibm-plex-kr",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "PIMS — 규정법령 어드바이저",
  description: "ICT기금 사용자 중심 AX서비스",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="ko"
      className={sans.variable}
      style={{ "--font-display": "var(--font-sans)" } as CSSProperties}
    >
      <head>
        <BotIdClient protect={PROTECTED_ROUTES} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
