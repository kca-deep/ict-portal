"use client";

import { SquarePen, Copy, Check, ArrowUp, Square, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Response } from "@/components/ui/response";
import {
  SourcePanel,
  relevancePercent,
  type SourceChunk,
} from "@/components/ui/source-panel";

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: SourceChunk[];
  responseMs?: number;
};

type StreamEvent =
  | { type: "sources"; data: SourceChunk[] }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 우측 근거 패널에 띄울 참조 문서(없으면 닫힘). 한 번에 하나만 연다.
  const [activeSource, setActiveSource] = useState<{
    source: SourceChunk;
    index: number;
  } | null>(null);
  // 위로 올려 읽는 중이면 '↓ 최신으로' 버튼을 띄운다(맨 아래에선 숨김).
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 진행 중인 /api/chat 요청을 '멈춤' 버튼에서 도중에 끊기 위한 핸들.
  const abortRef = useRef<AbortController | null>(null);
  // 사용자가 맨 아래 근처에 있을 때만 자동 스크롤. 위로 올리면 스트리밍 중에도 따라가지 않음.
  const stickToBottomRef = useRef(true);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // 맨 아래에 (거의) 닿았을 때만 자동추적 재개. 위로 올린 상태면 따라가지 않음.
    stickToBottomRef.current = distanceFromBottom < 24;
    setAtBottom(distanceFromBottom < 24);
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  }

  // 사용자의 "위로 스크롤" 의도를 동기적으로 포착해 자동추적을 즉시 해제한다.
  // onScroll은 다음 프레임에 비동기로 호출되어, 스트리밍 delta가 그 전에
  // scrollTo로 다시 끌어내리는 것을 막지 못한다. wheel/touch는 동기로 먼저 발생하므로
  // 여기서 stick=false로 만들면 이후 delta가 화면을 끌어내리지 않는다.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stickToBottomRef.current = false;
    };
    let lastTouchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      // 손가락을 아래로 끌면 = 콘텐츠를 위로 스크롤
      if (y > lastTouchY) stickToBottomRef.current = false;
      lastTouchY = y;
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
  }, [messages]);

  // 입력창 자동 높이: 첫 화면(대화 전)은 3행에서 시작, 대화 중에는 1행에서 시작.
  // 내용이 길어지면 늘어나고 5행에서 멈춘 뒤 내부 스크롤로 전환한다.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const LINE = 24; // text-[15px] leading-6 (1.5rem)
    const PAD = 32; // py-4 위아래 16px
    const firstScreen = messages.length === 0;
    const minRows = firstScreen ? 5 : 2;
    el.style.height = "auto";
    // 첫 화면 입력창은 기본 세로 높이를 1/4 줄인다(세로가 너무 길다는 피드백).
    const min = Math.round((minRows * LINE + PAD) * (firstScreen ? 0.75 : 1));
    const max = firstScreen ? 8 * LINE + PAD : 6 * LINE + PAD;
    const next = Math.min(Math.max(el.scrollHeight, min), max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [input, messages.length]);

  // Esc로 근거 패널 닫기.
  useEffect(() => {
    if (!activeSource) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveSource(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeSource]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    stickToBottomRef.current = true;
    const userMsg: Message = { role: "user", content: text };
    const historyForApi = [...messages, userMsg].map(({ role, content }) => ({
      role,
      content,
    }));
    setMessages((prev) => [
      ...prev,
      userMsg,
      { role: "assistant", content: "" },
    ]);
    setInput("");
    setError(null);
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // 스트리밍 표시용 rAF 타이프라이터 제어(try 안에서 사용, finally 에서 정리).
    let rafId = 0;
    let stopped = false;

    try {
      const startedAt = performance.now();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: historyForApi }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const msg = await res.text().catch(() => "");
        throw new Error(msg || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // 네트워크 수신(고빈도·불균일한 Anthropic delta burst)과 화면 갱신을 분리한다.
      // delta 는 target 에 즉시 누적만 하고, 실제 렌더(Streamdown 전체 재파싱)는 rAF 로
      // 프레임당 1회 이하만 수행한다. 표시 길이를 backlog 비례로 따라가게 해 burst 를
      // 매끄럽게 흘려보내되 네트워크보다 크게 뒤처지지 않게(≈수 프레임) 유지한다.
      // ※ 이전 타이프라이터 동결 원인은 '고정 1글자/프레임' → 프레임 수 폭증으로 매
      //   프레임 전체 재파싱이 누적된 것. backlog 비례 step + 변화 시에만 렌더로 해소.
      let target = "";
      let sources: SourceChunk[] | undefined;
      let displayed = 0;
      let streamDone = false;
      let lastLen = -1;
      let lastSources: SourceChunk[] | undefined;

      const paint = (content: string, responseMs?: number) => {
        setMessages((prev) => {
          const copy = prev.slice();
          const prevMsg = copy[copy.length - 1];
          copy[copy.length - 1] = {
            role: "assistant",
            content,
            sources,
            responseMs: responseMs ?? prevMsg?.responseMs,
          };
          return copy;
        });
      };

      const drain = new Promise<void>((resolve) => {
        const tick = () => {
          if (stopped) return resolve();
          // 네트워크 종료 시 남은 backlog 를 한 번에 확정 표시하고 종료
          // (탭 비활성으로 rAF 가 멈춰 await 가 영구 대기하는 것을 방지).
          if (streamDone) {
            paint(target, Math.round(performance.now() - startedAt));
            return resolve();
          }
          const backlog = target.length - displayed;
          if (backlog > 0) {
            displayed = Math.min(
              target.length,
              displayed + Math.max(2, Math.ceil(backlog / 5)),
            );
          }
          // 변화가 있을 때만 재파싱(대기 구간의 불필요한 렌더 방지).
          if (displayed !== lastLen || sources !== lastSources) {
            paint(target.slice(0, displayed));
            lastLen = displayed;
            lastSources = sources;
          }
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
      });

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let ev: StreamEvent;
          try {
            ev = JSON.parse(trimmed) as StreamEvent;
          } catch {
            continue;
          }

          if (ev.type === "sources") {
            sources = ev.data;
          } else if (ev.type === "delta") {
            target += ev.text;
          } else if (ev.type === "error") {
            throw new Error(ev.message);
          }
        }
      }
      streamDone = true;
      await drain; // 응답 시간은 최종 paint(streamDone 분기)에서 함께 기록된다.
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // 사용자가 '멈춤'을 눌렀다. 지금까지 받은 답은 그대로 남기되,
        // 한 글자도 못 받았으면 빈 말풍선을 제거한다.
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && !last.content) return prev.slice(0, -1);
          return prev;
        });
      } else {
        setError((err as Error).message);
        setMessages((prev) => prev.slice(0, -1));
      }
    } finally {
      // rAF 타이프라이터 정지(중단·에러 시 잔여 프레임이 부분 렌더를 계속하지 않도록).
      stopped = true;
      cancelAnimationFrame(rafId);
      abortRef.current = null;
      setLoading(false);
      textareaRef.current?.focus();
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function resetChat() {
    if (loading) return;
    setMessages([]);
    setError(null);
    setActiveSource(null);
  }

  // 버튼 위치: 입력창 우하단. 둥근 모서리 때문에 하단 여백을 우측보다 약간 더 줌.
  const composerBtnPos = "right-3 bottom-4";

  // 중앙(첫 화면)·하단(대화 중) 어디서든 동일하게 쓰는 입력창. 높이는 위 effect가 제어.
  const composer = (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="메시지를 입력하세요…"
        rows={messages.length === 0 ? 3 : 2}
        className="w-full resize-none rounded-xl border border-composer-border pl-5 pr-14 py-4 text-[15px] leading-6 bg-composer text-card-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring shadow-sm transition-shadow focus:shadow-md"
        disabled={loading}
      />
      {loading ? (
        <button
          onClick={stop}
          aria-label="멈춤"
          title="멈춤"
          className={`absolute ${composerBtnPos} inline-flex items-center justify-center h-9 w-9 rounded-xl bg-destructive text-destructive-foreground shadow-md transition-opacity hover:opacity-90`}
        >
          <Square className="w-4 h-4 fill-current" aria-hidden />
        </button>
      ) : (
        <button
          onClick={send}
          disabled={!input.trim()}
          aria-label="전송"
          title="전송"
          className={`absolute ${composerBtnPos} inline-flex items-center justify-center h-9 w-9 rounded-xl bg-primary text-primary-foreground shadow-md transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          <ArrowUp className="w-5 h-5" aria-hidden />
        </button>
      )}
    </div>
  );

  return (
    <main className="flex h-screen bg-background overflow-hidden">
      <div className="flex-1 flex flex-col h-full min-w-0">
        {/* Header — 하단 구분선을 전체 가로 폭으로 표시, 내용만 채팅 컬럼에 정렬 */}
        <header className="shrink-0 border-b-2 border-b-primary/25 bg-background/80 backdrop-blur-sm">
          <div
            className={`flex items-center justify-between px-6 py-2 ${
              activeSource ? "" : "max-w-3xl mx-auto"
            }`}
          >
          <div className="flex items-center gap-3">
            <svg
              viewBox="10 78 380 292"
              role="img"
              aria-label="PIMS 어드바이저 로고"
              className="h-12 w-[62px] shrink-0"
            >
              <defs>
                <linearGradient id="pimsAppSky" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#6fb7f0" />
                  <stop offset="1" stopColor="#3d93de" />
                </linearGradient>
                <linearGradient id="pimsAppTail" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#ffce5c" />
                  <stop offset="1" stopColor="#f39b1e" />
                </linearGradient>
                <linearGradient id="pimsAppP" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#ffc62b" />
                  <stop offset="1" stopColor="#f5a50d" />
                </linearGradient>
              </defs>
              <rect
                x="28"
                y="92"
                width="344"
                height="200"
                rx="66"
                fill="#ffffff"
                stroke="url(#pimsAppSky)"
                strokeWidth="15"
              />
              <path d="M118 272 L82 360 Q76 372 90 364 L166 314 Z" fill="url(#pimsAppTail)" />
              <text
                x="200"
                y="224"
                textAnchor="middle"
                fontFamily="'Pretendard','Segoe UI',Arial,sans-serif"
                fontWeight="800"
                letterSpacing="1"
              >
                <tspan fontSize="112" fill="url(#pimsAppP)">P</tspan>
                <tspan fontSize="100" fill="#2a7df0">IMS</tspan>
              </text>
            </svg>
            <div className="flex flex-col justify-center h-11">
              <h1
                className="text-lg font-bold leading-tight tracking-tight text-foreground"
                style={{ fontFamily: "var(--font-display)" }}
              >
                AI Advisor
              </h1>
              <p className="text-xs text-muted-foreground leading-tight">
                ICT기금 규정·지침·법령 안내
              </p>
            </div>
          </div>
          <button
            onClick={resetChat}
            disabled={loading || messages.length === 0}
            aria-label="새 대화"
            title="새 대화"
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 p-2 rounded-md hover:bg-card"
          >
            <SquarePen className="w-5 h-5" aria-hidden="true" />
          </button>
          </div>
        </header>

        <div
          className={`flex flex-col w-full flex-1 min-h-0 ${
            activeSource ? "" : "max-w-3xl mx-auto"
          }`}
        >
        {messages.length === 0 ? (
          /* 첫 화면: 인사말 + 입력창을 화면 정중앙에 배치 (ChatGPT·Claude·Gemini 방식).
             pb 로 헤더 높이(약 60px)만큼 보정 → 헤더 포함 전체 뷰포트 기준 정중앙. */
          <div className="flex-1 flex flex-col items-center justify-center px-4 pb-[60px]">
            <div className="w-full max-w-3xl flex flex-col items-center text-center">
              <p
                className="mb-7 text-3xl font-medium tracking-tight text-foreground"
                style={{ fontFamily: "var(--font-display)" }}
              >
                무엇을 도와드릴까요?
              </p>
              <div className="w-full max-w-[700px] relative">
                <div className="composer-cloud" aria-hidden />
                <div className="relative">{composer}</div>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Conversation */}
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto px-6 py-6 space-y-4"
            >
              {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[88%] rounded-2xl rounded-br-md px-4 py-3 bg-primary text-primary-foreground shadow-lg text-sm leading-relaxed whitespace-pre-wrap break-words">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[92%] flex flex-col gap-2">
                  <div className="rounded-2xl rounded-tl-md px-4 py-3 bg-card text-card-foreground border border-border shadow-sm break-words">
                    {m.content ? (
                      <Response>{m.content}</Response>
                    ) : (
                      <span className="inline-flex gap-1 items-center text-card-foreground/70">
                        <span className="w-1.5 h-1.5 rounded-full bg-card-foreground animate-bounce [animation-delay:-0.3s]" />
                        <span className="w-1.5 h-1.5 rounded-full bg-card-foreground animate-bounce [animation-delay:-0.15s]" />
                        <span className="w-1.5 h-1.5 rounded-full bg-card-foreground animate-bounce" />
                      </span>
                    )}
                    {m.content && !(loading && i === messages.length - 1) && (
                      <>
                        {/* 모든 답변 끝에 고정 표시되는 면책 안내(LLM 출력과 무관). */}
                        <div className="mt-3 pt-3 border-t border-card-foreground/15 flex gap-2 text-[13px] italic leading-relaxed text-muted-foreground">
                          <TriangleAlert
                            className="w-4 h-4 shrink-0 mt-0.5 text-amber-500"
                            aria-hidden
                          />
                          <span>
                            본 답변은 참고용 안내이며 확정적 법률 자문이 아닙니다.
                            최종 판단은 법제처 원문 및 소관 부서 확인을 거치시기
                            바랍니다.
                          </span>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          {m.responseMs != null && (
                            <span className="text-[11px] text-muted-foreground tabular-nums">
                              응답 {(m.responseMs / 1000).toFixed(1)}초
                            </span>
                          )}
                          <CopyButton text={m.content} />
                        </div>
                      </>
                    )}
                  </div>
                  {m.sources && m.sources.length > 0 && (
                    <Sources
                      sources={m.sources}
                      active={activeSource?.source ?? null}
                      onOpen={(source, index) =>
                        setActiveSource({ source, index })
                      }
                    />
                  )}
                </div>
              </div>
            ),
          )}

          {error && (
            <div className="rounded-lg text-sm px-4 py-3 bg-destructive text-destructive-foreground shadow-lg">
              {error}
            </div>
          )}
        </div>

            {/* Input */}
            <div className="px-4 py-4 shrink-0 relative">
              {!atBottom && (
                <button
                  onClick={scrollToBottom}
                  className="absolute -top-7 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full bg-card text-card-foreground text-xs font-medium px-3 py-1.5 shadow-lg border border-border hover:bg-muted/40 transition-colors"
                >
                  ↓ 최신으로
                </button>
              )}
              {composer}
            </div>
          </>
        )}
        </div>
      </div>

      {activeSource && (
        <SourcePanel
          source={activeSource.source}
          index={activeSource.index}
          onClose={() => setActiveSource(null)}
        />
      )}
    </main>
  );
}

/** 답변 말풍선마다 붙는 복사 버튼. 원본 마크다운 텍스트를 클립보드에 넣는다. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 클립보드 접근 실패(권한·비보안 컨텍스트)는 조용히 무시한다.
    }
  }
  return (
    <button
      onClick={copy}
      className={`inline-flex items-center justify-center rounded-md p-1 transition-colors ${
        copied
          ? "text-primary"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
      }`}
      aria-label={copied ? "복사됨" : "답변 복사"}
      title={copied ? "복사됨" : "답변 복사"}
    >
      {copied ? (
        <Check className="w-3.5 h-3.5" aria-hidden />
      ) : (
        <Copy className="w-3.5 h-3.5" aria-hidden />
      )}
    </button>
  );
}

/**
 * 접힌 미리보기용: 표(| ... |, |---|) 줄은 통째로 건너뛰고, 마크다운 기호
 * (#, *, >, ` 등)를 걷어낸 본문 텍스트만 한 줄로 압축한다.
 */
function plainPreview(md: string): string {
  const kept: string[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // 표 구분선 (|---|---|, :---:) 제외
    if (/^\|?\s*:?-{3,}/.test(line)) continue;
    // 표 행 (파이프가 2개 이상) 제외
    if ((line.match(/\|/g)?.length ?? 0) >= 2) continue;
    kept.push(line);
  }
  return kept
    .join(" ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function Sources({
  sources,
  active,
  onOpen,
}: {
  sources: SourceChunk[];
  active: SourceChunk | null;
  onOpen: (source: SourceChunk, index: number) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-accent text-accent-foreground shadow-sm overflow-hidden">
      <div className="px-3 py-2 text-xs font-semibold text-muted-foreground border-b border-border">
        참조 문서 {sources.length}건
      </div>
      <ol className="divide-y divide-border">
        {sources.map((s, i) => (
          <SourceItem
            key={s.id}
            index={i}
            source={s}
            active={active === s}
            onOpen={() => onOpen(s, i)}
          />
        ))}
      </ol>
    </div>
  );
}

function SourceItem({
  index,
  source,
  active,
  onOpen,
}: {
  index: number;
  source: SourceChunk;
  active: boolean;
  onOpen: () => void;
}) {
  const article = (source.metadata?.article as string | undefined) ?? null;
  const kind = source.metadata?.kind;
  const isLaw = kind === "law";
  const isPrecedent = kind === "precedent";
  const percent = relevancePercent(source.score);
  // 출처 종류 = 좌측 보더 색(색약 안전). 법령·판례=앰버 / 규정=블루.
  // divide-border가 첫 항목 외 자식의 border-color(전 방향)를 덮어써 2번째 이후의
  // 좌측 색이 중성 보더로 바뀐다 → 좌측 색만 !important로 고정해 divide를 이긴다.
  const borderClass = isLaw || isPrecedent ? "!border-l-badge-law" : "!border-l-badge-regulation";

  return (
    <li className={`text-xs border-l-2 ${borderClass}`}>
      <button
        onClick={onOpen}
        className={`w-full flex items-start gap-2 px-3 py-2 text-left transition-colors ${
          active ? "bg-primary/10" : "hover:bg-muted/40"
        }`}
        aria-pressed={active}
        title="누르면 오른쪽 패널에서 원문을 봅니다"
      >
        <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-md bg-primary/15 text-primary font-semibold text-[10px]">
          {index + 1}
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="font-semibold text-foreground">
              {source.title ?? "(제목 없음)"}
            </span>
            {article && (
              <span className="text-[10px] text-muted-foreground">{article}</span>
            )}
          </span>
          <span className="block truncate text-muted-foreground/80">
            {plainPreview(source.content)}
          </span>
        </span>
        {isLaw ? (
          <span
            className="shrink-0 inline-flex items-center rounded-full bg-badge-law/12 px-1.5 py-0.5 text-[10px] font-semibold text-badge-law mt-0.5"
            title="법제처 국가법령정보"
          >
            법제처 법령
          </span>
        ) : isPrecedent ? (
          <span
            className="shrink-0 inline-flex items-center rounded-full bg-badge-law/12 px-1.5 py-0.5 text-[10px] font-semibold text-badge-law mt-0.5"
            title="법제처 판례·헌재결정"
          >
            판례
          </span>
        ) : (
          <span
            className="shrink-0 inline-flex items-center rounded-full bg-badge-regulation/12 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-badge-regulation mt-0.5"
            title="검색 관련도 (Cohere rerank)"
          >
            {percent}% 관련도
          </span>
        )}
        <span className="shrink-0 text-[10px] text-muted-foreground/70 mt-0.5" aria-hidden>
          ↗
        </span>
      </button>
    </li>
  );
}
