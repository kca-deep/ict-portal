import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "streamdown/styles.css";

// 헤더 워드마크·인사말용 디스플레이 폰트: KoPub World 돋움(자체 호스팅). --font-display 로만 사용.
const display = localFont({
  src: [
    { path: "./fonts/KoPubDotum-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/KoPubDotum-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-display",
  display: "swap",
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
    <html lang="ko" className={display.variable}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
