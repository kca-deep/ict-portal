"use client";

import Image from "next/image";
import { SquarePen, Copy, Check } from "lucide-react";
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

  return (
    <main className="flex h-screen bg-background">
      <div className="flex-1 flex flex-col h-full min-w-0">
        <div
          className={`flex flex-col w-full h-full ${
            activeSource ? "" : "max-w-3xl mx-auto"
          }`}
        >
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-4 shrink-0 border-b border-border bg-background/80 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <Image
              src="/pims-logo.png"
              alt="PIMS 어드바이저 로고"
              width={40}
              height={40}
              priority
              className="w-10 h-10 shrink-0"
            />
            <div>
              <h1 className="text-base font-semibold leading-tight tracking-tight text-foreground">
                PIMS 어드바이저
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
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
        </header>

        {/* Conversation */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-6 py-6 space-y-4"
        >
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-16 h-16 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-lg font-bold tracking-tight shadow-xl mb-5">
                PIMS
              </div>
              <p className="font-semibold text-foreground text-lg">
                무엇이든 물어보세요
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                ICT기금 규정 RAG 기반 답변 · Shift+Enter 줄바꿈 · Enter 전송
              </p>
            </div>
          )}

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
                  <div className="rounded-2xl rounded-tl-md px-4 py-3 bg-accent text-accent-foreground shadow-sm break-words">
                    {m.content ? (
                      <Response>{m.content}</Response>
                    ) : (
                      <span className="inline-flex gap-1 items-center text-accent-foreground/70">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent-foreground animate-bounce [animation-delay:-0.3s]" />
                        <span className="w-1.5 h-1.5 rounded-full bg-accent-foreground animate-bounce [animation-delay:-0.15s]" />
                        <span className="w-1.5 h-1.5 rounded-full bg-accent-foreground animate-bounce" />
                      </span>
                    )}
                    {m.content && !(loading && i === messages.length - 1) && (
                      <div className="mt-2 flex items-center gap-2">
                        {m.responseMs != null && (
                          <span className="text-[11px] text-muted-foreground tabular-nums">
                            응답 {(m.responseMs / 1000).toFixed(1)}초
                          </span>
                        )}
                        <CopyButton text={m.content} />
                      </div>
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
          {!atBottom && messages.length > 0 && (
            <button
              onClick={scrollToBottom}
              className="absolute -top-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full bg-card text-card-foreground text-xs font-medium px-3 py-1.5 shadow-lg border border-border hover:bg-muted/40 transition-colors"
            >
              ↓ 최신으로
            </button>
          )}
          <div className="flex gap-2 items-end">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="메시지를 입력하세요…"
              rows={1}
              className="flex-1 resize-none rounded-2xl px-4 py-3 text-sm bg-card text-card-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring shadow-lg max-h-40"
              disabled={loading}
            />
            {loading ? (
              <button
                onClick={stop}
                className="rounded-2xl bg-destructive text-destructive-foreground text-sm font-semibold px-5 py-3 shadow-lg transition-opacity hover:opacity-90"
              >
                멈춤
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!input.trim()}
                className="rounded-2xl bg-primary text-primary-foreground text-sm font-semibold px-5 py-3 shadow-lg transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                전송
              </button>
            )}
          </div>
        </div>
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
    <div className="rounded-xl border border-border bg-card text-card-foreground shadow-sm overflow-hidden">
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

  return (
    <li className="text-xs">
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
            className="shrink-0 inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary mt-0.5"
            title="법제처 국가법령정보"
          >
            법제처 법령
          </span>
        ) : isPrecedent ? (
          <span
            className="shrink-0 inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary mt-0.5"
            title="법제처 판례·헌재결정"
          >
            판례
          </span>
        ) : (
          <span
            className="shrink-0 inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-primary mt-0.5"
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
