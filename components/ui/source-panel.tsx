"use client";

import { Response } from "@/components/ui/response";

export type SourceChunk = {
  id: number;
  title: string | null;
  source_ref: string | null;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
};

// Cohere relevanceScore(0~1)를 관련도 %로 변환. 0~100 범위로 안전하게 클램프.
export function relevancePercent(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score * 100)));
}

type SourceKind = "regulation" | "law" | "precedent";

export function kindOf(source: SourceChunk): SourceKind {
  const k = source.metadata?.kind;
  if (k === "law") return "law";
  if (k === "precedent") return "precedent";
  return "regulation";
}

// 출처 종류별 뱃지 (📘 내부규정=블루 / ⚖️ 법령·판례=앰버). 공모공고(8월)=그린 추가 예정.
// 아티팩트 패널은 잉크 다크 배경이라, 뱃지는 밝은 중립 칩으로 두고(가독성) 종류 색은
// 패널 좌측 보더(borderClass)가 담당한다 — 색약 안전한 의미 구분.
const BADGE: Record<
  SourceKind,
  { icon: string; label: string; borderClass: string }
> = {
  regulation: { icon: "📘", label: "내부규정", borderClass: "border-l-badge-regulation" },
  law: { icon: "⚖️", label: "법령", borderClass: "border-l-badge-law" },
  precedent: { icon: "⚖️", label: "판례", borderClass: "border-l-badge-law" },
};

/**
 * 우측 근거 패널 — 참조 문서를 누르면 답변은 그대로 둔 채 오른쪽(넓은 화면) 또는
 * 아래에서 올라오는 바텀시트(좁은 화면)로 원문을 보여 준다. X·바깥·Esc로 닫는다.
 */
export function SourcePanel({
  source,
  index,
  onClose,
}: {
  source: SourceChunk;
  index: number;
  onClose: () => void;
}) {
  const kind = kindOf(source);
  const badge = BADGE[kind];
  const article = (source.metadata?.article as string | undefined) ?? null;
  const percent = relevancePercent(source.score);
  // 법령 카드엔 법제처(law.go.kr) 원문 링크. 법령명으로 바로 여는 공식 경로.
  const lawUrl =
    kind === "law" && source.title
      ? `https://www.law.go.kr/법령/${encodeURIComponent(source.title)}`
      : null;

  return (
    <>
      {/* 좁은 화면용 backdrop — 바깥을 누르면 닫힘 */}
      <div
        className="md:hidden fixed inset-0 z-30 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      {/* 바깥 컨테이너 = 위치/여백만. 안쪽 카드를 띄워 '새 창(말풍선)'처럼 보이게 한다. */}
      <aside
        role="dialog"
        aria-label="근거 원문"
        className="
          fixed inset-x-0 bottom-0 z-40 flex max-h-[88vh] flex-col p-3
          md:static md:inset-auto md:z-auto md:h-full md:max-h-none md:w-2/5 md:shrink-0 md:p-5 md:pl-2.5
        "
      >
        {/* 잉크 다크 집중 패널 — 좌측 보더가 출처 종류 색(블루/앰버). artifact-ink: 내부
            마크다운(표·코드)이 잉크 토큰을 쓰도록 스코프 오버라이드(흰 표 카드 묻힘 방지). */}
        <div className={`artifact-ink flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border border-white/10 border-l-4 ${badge.borderClass} bg-secondary text-secondary-foreground shadow-2xl ring-1 ring-black/20`}>
          {/* 헤더: 뱃지(종류·관련도) · 제목 · 닫기 */}
          <div className="flex items-start gap-3 border-b border-white/10 px-8 py-5 shrink-0">
            {/* 종류 + 관련도(내부 규정만)를 한 뱃지 카드 안에 줄바꿈으로 표시 */}
            <span className="mt-0.5 inline-flex shrink-0 flex-col items-center gap-0.5 rounded-xl bg-white/10 px-2.5 py-1 text-secondary-foreground">
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold">
                <span aria-hidden>{badge.icon}</span>
                {badge.label}
              </span>
              {kind === "regulation" && (
                <span className="text-[10px] font-medium tabular-nums text-secondary-foreground/75">
                  관련도 {percent}%
                </span>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold text-secondary-foreground">
                <span className="text-secondary-foreground/55">[{index + 1}] </span>
                {source.title ?? "(제목 없음)"}
              </p>
              {article && (
                <p className="mt-0.5 truncate text-xs text-secondary-foreground/65">{article}</p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="근거 패널 닫기"
              className="-mr-1.5 -mt-1 shrink-0 rounded-full p-2 text-secondary-foreground/70 transition-colors hover:bg-white/10 hover:text-secondary-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* 본문: 조문 원문 (Streamdown 은 currentColor 상속 → 밝은 텍스트로 렌더) */}
          <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6 text-sm text-secondary-foreground">
            {/* 패널 본문은 행간을 채팅 말풍선보다 살짝 좁힌다 */}
            <Response className="leading-tight [&_p]:leading-tight [&_li]:leading-tight">
              {source.content}
            </Response>
          </div>

          {/* 푸터: 출처 / 법제처 링크 (관련도는 헤더 뱃지로 이동) */}
          <div className="shrink-0 space-y-2 border-t border-white/10 px-8 py-5 text-[11px] text-secondary-foreground/70">
            {source.source_ref && <p className="break-words">출처: {source.source_ref}</p>}
            {lawUrl && (
              <a
                href={lawUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-semibold text-secondary-foreground underline underline-offset-2 hover:text-white"
              >
                법제처 원문 ↗
              </a>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
