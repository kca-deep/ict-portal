"use client";

import { useState } from "react";

export default function Home() {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || loading) return;

    setLoading(true);
    setAnswer("");
    setError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok || !res.body) {
        const msg = await res.text().catch(() => "");
        throw new Error(msg || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        setAnswer((prev) => prev + decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen p-6 sm:p-10 max-w-3xl mx-auto">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">규정법령 어드바이저</h1>
        <p className="text-sm text-muted-foreground mt-1">
          ICT기금 내부 규정 + 법제처 법령·판례 기반 RAG · PoC
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-3 mb-8">
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="예: ICT기금 사업비 집행 시 증빙서류는 어떤 것이 필요한가요?"
          rows={3}
          className="w-full border rounded-lg px-4 py-3 bg-background resize-none focus:outline-none focus:ring-2 focus:ring-accent"
          disabled={loading}
        />
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="px-5 py-2 rounded bg-foreground text-background text-sm font-medium disabled:opacity-50"
          >
            {loading ? "답변 생성 중…" : "질문하기"}
          </button>
        </div>
      </form>

      {error && (
        <div className="mb-6 p-4 rounded border border-red-300 bg-red-50 text-red-900 text-sm">
          {error}
        </div>
      )}

      {answer && (
        <article className="whitespace-pre-wrap rounded-lg p-5 bg-muted border text-sm leading-relaxed">
          {answer}
        </article>
      )}
    </main>
  );
}
