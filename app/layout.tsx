import type { Metadata } from "next";
import { Instrument_Serif } from "next/font/google";
import "./globals.css";
import "streamdown/styles.css";

// 헤더 워드마크용 디스플레이 폰트(이탤릭). 본문과 분리해 --font-display 로만 사용.
const display = Instrument_Serif({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
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
