import type { Metadata } from "next";
import "./globals.css";
import "streamdown/styles.css";

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
    <html lang="ko">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
