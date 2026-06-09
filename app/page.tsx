"use client";

import { useEffect, useRef, useState } from "react";
import { Response } from "@/components/ui/response";

type SourceChunk = {
  id: number;
  title: string | null;
  source_ref: string | null;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: SourceChunk[];
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 사용자가 맨 아래 근처에 있을 때만 자동 스크롤. 위로 올리면 스트리밍 중에도 따라가지 않음.
  const stickToBottomRef = useRef(true);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // 맨 아래에 (거의) 닿았을 때만 자동추적 재개. 위로 올린 상태면 따라가지 않음.
    stickToBottomRef.current = distanceFromBottom < 24;
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

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: historyForApi }),
      });
      if (!res.ok || !res.body) {
        const msg = await res.text().catch(() => "");
        throw new Error(msg || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      let sources: SourceChunk[] | undefined;

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
            acc += ev.text;
          } else if (ev.type === "error") {
            throw new Error(ev.message);
          }

          setMessages((prev) => {
            const copy = prev.slice();
            copy[copy.length - 1] = {
              role: "assistant",
              content: acc,
              sources,
            };
            return copy;
          });
        }
      }
    } catch (err) {
      setError((err as Error).message);
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setLoading(false);
      textareaRef.current?.focus();
    }
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
  }

  return (
    <main className="flex h-screen bg-background">
      <div className="flex flex-col w-full max-w-3xl mx-auto h-full">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold shadow-lg">
              AI
            </div>
            <div>
              <h1 className="text-base font-semibold leading-tight tracking-tight text-foreground">
                PIMS Chat
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Claude · claude-sonnet-4-6 · RAG (regulation)
              </p>
            </div>
          </div>
          <button
            onClick={resetChat}
            disabled={loading || messages.length === 0}
            className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 px-3 py-1.5 rounded-md hover:bg-card"
          >
            새 대화
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
              <div className="w-16 h-16 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xl font-bold shadow-xl mb-5">
                AI
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
                <div className="max-w-[78%] rounded-2xl rounded-br-md px-4 py-3 bg-primary text-primary-foreground shadow-lg text-sm leading-relaxed whitespace-pre-wrap break-words">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start gap-2.5">
                <div className="w-8 h-8 shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold shadow-md mt-0.5">
                  AI
                </div>
                <div className="max-w-[78%] flex flex-col gap-2">
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
                  </div>
                  {m.sources && m.sources.length > 0 && (
                    <Sources sources={m.sources} />
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
        <div className="px-4 py-4 shrink-0">
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
            <button
              onClick={send}
              disabled={loading || !input.trim()}
              className="rounded-2xl bg-primary text-primary-foreground text-sm font-semibold px-5 py-3 shadow-lg transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? "…" : "전송"}
            </button>
          </div>
        </div>
      </div>
    </main>
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

function Sources({ sources }: { sources: SourceChunk[] }) {
  return (
    <div className="rounded-xl border border-border bg-card text-card-foreground shadow-sm overflow-hidden">
      <div className="px-3 py-2 text-xs font-semibold text-muted-foreground border-b border-border">
        참조 문서 {sources.length}건
      </div>
      <ol className="divide-y divide-border">
        {sources.map((s, i) => (
          <SourceItem key={s.id} index={i} source={s} />
        ))}
      </ol>
    </div>
  );
}

function SourceItem({ index, source }: { index: number; source: SourceChunk }) {
  const [open, setOpen] = useState(false);
  const article = (source.metadata?.article as string | undefined) ?? null;

  return (
    <li className="text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
        aria-expanded={open}
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
          {!open && (
            <span className="block truncate text-muted-foreground/80">
              {plainPreview(source.content)}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground/70 mt-0.5">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 text-muted-foreground">
          <Response>{source.content}</Response>
          {source.source_ref && (
            <p className="mt-2 text-[10px] text-muted-foreground/70">
              출처: {source.source_ref}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
