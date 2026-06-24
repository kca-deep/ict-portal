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

    // Streamdown은 모든 마크다운 요소를 자체 유틸 클래스로 스타일하므로 prose 래퍼를
    // 쓰지 않는다(prose를 덧씌우면 마진·색이 이중 적용되어 충돌). 여기서는 말풍선
    // 안쪽에 맞춰 첫·마지막 블록의 바깥 여백만 제거한다.
    return (
      <Streamdown
        data-slot="response"
        plugins={mergedPlugins}
        className={cn(
          "text-sm leading-snug [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_li]:py-0.5 [&>*+*]:!mt-3",
          className,
        )}
        {...props}
      />
    );
  },
  (prev, next) => prev.children === next.children,
);

Response.displayName = "Response";
