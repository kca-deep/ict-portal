"use client";

import { useRouter } from "next/navigation";

// 페이지당 건수 콤보 — 필터 행(서버 렌더)에 들어가는 클라이언트 아일랜드.
// 페이지 크기는 URL ?ps= 로 관리해 서버(page.tsx)가 초기 행을 그 크기로 내려준다.
const SIZES = [10, 20, 50, 100, 200, 300] as const;

export function PageSizeSelect({
  value,
  query,
  base,
}: {
  value: number;
  query: Record<string, string | undefined>;
  base: string;
}) {
  const router = useRouter();
  return (
    <select
      aria-label="페이지당 건수"
      value={value}
      onChange={(e) => {
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) if (v) p.set(k, v);
        p.set("ps", e.target.value);
        p.delete("log");
        router.push(`${base}?${p.toString()}`);
      }}
      className="h-full bg-transparent px-2.5 py-1.5 text-[13px] text-foreground outline-none"
    >
      {SIZES.map((n) => (
        <option key={n} value={n}>
          {n}건
        </option>
      ))}
    </select>
  );
}
