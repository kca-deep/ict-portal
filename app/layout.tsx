import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { IBM_Plex_Sans_KR } from "next/font/google";
import "./globals.css";
import "streamdown/styles.css";

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
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
