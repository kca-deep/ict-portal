"use client";

import { memo, useMemo } from "react";
import { Streamdown } from "streamdown";
import remarkCjkFriendly from "remark-cjk-friendly";
import { cn } from "@/lib/utils";

type ResponseProps = React.ComponentProps<typeof Streamdown>;

/**
 * shadcn 스타일 마크다운 뷰어. 스트리밍 중 불완전 토큰을 안전하게 렌더링한다.
 * 채팅 말풍선 내부에 들어가도록 prose 폭 제약을 풀고, 첫·마지막 블록의 외부 여백만 제거한다.
 *
 * - Streamdown 기본 remark 파이프라인(remark-gfm 포함)은 그대로 두고,
 *   plugins.cjk 슬롯으로 remark-cjk-friendly만 끼워 넣는다.
 *   (remarkPlugins prop을 직접 넘기면 default gfm을 덮어써서 표/취소선/체크박스가 깨짐)
 * - remark-cjk-friendly: `**자산)**에` 처럼 닫는 ** 뒤에 한글 조사가 붙는 경우의
 *   CommonMark flanking 규칙 위반을 완화해 굵게 처리가 되도록 함.
 */
export const Response = memo(
  ({ className, plugins, ...props }: ResponseProps) => {
    const mergedPlugins = useMemo(
      () => ({
        ...plugins,
        cjk: plugins?.cjk ?? {
          name: "cjk" as const,
          type: "cjk" as const,
          remarkPluginsBefore: [remarkCjkFriendly],
          remarkPluginsAfter: [],
          remarkPlugins: [],
        },
      }),
      [plugins],
    );

    return (
      <Streamdown
        data-slot="response"
        plugins={mergedPlugins}
        className={cn(
          "prose prose-sm dark:prose-invert max-w-none",
          "prose-headings:font-semibold prose-headings:tracking-tight",
          "prose-p:leading-relaxed prose-li:leading-relaxed",
          "prose-pre:bg-muted prose-pre:text-foreground prose-pre:rounded-md",
          "prose-code:before:content-none prose-code:after:content-none",
          "prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.85em]",
          "prose-a:text-primary hover:prose-a:underline",
          "prose-table:my-2 prose-table:border prose-table:border-border",
          "prose-th:bg-muted/40 prose-th:px-2 prose-th:py-1 prose-th:border prose-th:border-border",
          "prose-td:px-2 prose-td:py-1 prose-td:border prose-td:border-border",
          "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className,
        )}
        {...props}
      />
    );
  },
  (prev, next) => prev.children === next.children,
);

Response.displayName = "Response";
