"use client";

import { useState, type ComponentProps } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Label,
  Pie,
  PieChart,
  ReferenceDot,
  Sector,
  XAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

// 대시보드 차트(클라이언트 아일랜드). 서버(admin/page.tsx)에서 집계된 숫자만 props 로
// 넘어온다 — service_role 클라이언트나 원시 로그 행은 경계를 넘지 않는다. 색은 shadcn
// ChartConfig 가 주입하는 --color-<key> 변수로 지정해 SVG fill 의 var() 처리를 안전하게 한다.

const usageConfig = {
  count: { label: "질의 수", color: "var(--primary)" },
} satisfies ChartConfig;

// 사용량 추이 — 그라디언트 area(2026 트렌드). natural 곡선 + 상단 진하게→하단 투명,
// 마지막 지점 글로우 마커로 '현재'를 강조. 그리드는 가로 점선만(미니멀).
export function UsageChart({ data }: { data: { label: string; count: number }[] }) {
  const last = data.length - 1;
  return (
    <ChartContainer config={usageConfig} className="mt-5 h-32 w-full">
      <AreaChart accessibilityLayer data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="usageGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-count)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--color-count)" stopOpacity={0.02} />
          </linearGradient>
          <filter id="usageGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} />
        <ChartTooltip
          cursor={{ stroke: "var(--color-count)", strokeOpacity: 0.3, strokeWidth: 1 }}
          content={<ChartTooltipContent />}
        />
        <Area
          dataKey="count"
          type="natural"
          stroke="var(--color-count)"
          strokeWidth={2}
          fill="url(#usageGrad)"
          dot={false}
          activeDot={{ r: 4, strokeWidth: 0, fill: "var(--color-count)" }}
        />
        {last >= 0 && (
          <ReferenceDot
            x={data[last].label}
            y={data[last].count}
            r={3.5}
            fill="var(--color-count)"
            stroke="var(--background)"
            strokeWidth={2}
            filter="url(#usageGlow)"
            isFront
          />
        )}
      </AreaChart>
    </ChartContainer>
  );
}

// 분기 분포. 색은 라우트(엔티티)에 고정. 미분류(unknown)까지 포함해 합=total.
// unknown 색은 admin/page.tsx 의 UNKNOWN_META.color 와 반드시 동일해야 범례와 일치.
const routeConfig = {
  regulation: { label: "규정", color: "var(--badge-regulation)" },
  law: { label: "법령", color: "var(--badge-law)" },
  out_of_scope: { label: "범위밖", color: "var(--muted-foreground)" },
  unknown: { label: "미분류", color: "oklch(0.72 0.02 75)" },
} satisfies ChartConfig;

// hover 한 조각을 바깥으로 6px 확대(activeShape 트렌드).
function renderActiveShape(props: ComponentProps<typeof Sector>) {
  return <Sector {...props} outerRadius={Number(props.outerRadius ?? 0) + 6} />;
}

export function RouteDonut({
  data,
  total,
}: {
  data: { route: keyof typeof routeConfig; count: number }[];
  total: number;
}) {
  const slices = data.filter((d) => d.count > 0);
  const [active, setActive] = useState<number | undefined>(undefined);
  return (
    <ChartContainer config={routeConfig} className="mx-auto aspect-square h-[150px]">
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent nameKey="route" hideLabel />} />
        <Pie
          data={slices}
          dataKey="count"
          nameKey="route"
          innerRadius={50}
          outerRadius={70}
          paddingAngle={2}
          strokeWidth={0}
          activeIndex={active ?? -1}
          activeShape={renderActiveShape}
          onMouseEnter={(_, i) => setActive(i)}
          onMouseLeave={() => setActive(undefined)}
        >
          {slices.map((d) => (
            <Cell key={d.route} fill={`var(--color-${d.route})`} />
          ))}
          <Label
            content={({ viewBox }) => {
              if (!viewBox || !("cx" in viewBox)) return null;
              const { cx, cy } = viewBox as { cx: number; cy: number };
              return (
                <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                  <tspan x={cx} y={cy - 3} className="fill-foreground font-serif" style={{ fontSize: 22 }}>
                    {total.toLocaleString()}
                  </tspan>
                  <tspan x={cx} y={cy + 15} className="fill-muted-foreground" style={{ fontSize: 10 }}>
                    질의
                  </tspan>
                </text>
              );
            }}
          />
        </Pie>
      </PieChart>
    </ChartContainer>
  );
}
