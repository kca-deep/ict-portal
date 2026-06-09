import { NextRequest } from "next/server";
import { ragChatStream, type ChatMessage, type RetrievedDoc } from "@/lib/ai/llm-router";
import { regulationSearch } from "@/lib/db/search";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;

type ChatRequest = {
  messages: ChatMessage[];
};

export type SourceChunk = {
  id: number;
  title: string | null;
  source_ref: string | null;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
};

export type StreamEvent =
  | { type: "sources"; data: SourceChunk[] }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

function isValidMessages(value: unknown): value is ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (m) =>
      m &&
      typeof m === "object" &&
      (m as ChatMessage).role !== undefined &&
      ((m as ChatMessage).role === "user" ||
        (m as ChatMessage).role === "assistant") &&
      typeof (m as ChatMessage).content === "string" &&
      (m as ChatMessage).content.trim().length > 0,
  );
}

export async function POST(req: NextRequest) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return new Response("invalid json body", { status: 400 });
  }

  if (!isValidMessages(body.messages)) {
    return new Response("messages required: [{role, content}]", {
      status: 400,
    });
  }

  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return new Response("last user message required", { status: 400 });
  }
  const query = lastUser.content.trim();

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, ev: StreamEvent) => {
    controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const hits = await regulationSearch(query, env.RERANK_TOP_K);
        const sources: SourceChunk[] = hits.map((h) => ({
          id: h.id,
          title: h.title,
          source_ref: h.source_ref,
          content: h.content,
          metadata: h.metadata,
          score: h.rrf_score,
        }));
        send(controller, { type: "sources", data: sources });

        const retrievedDocs: RetrievedDoc[] = sources.map((s) => ({
          title: s.title,
          source_ref: s.source_ref,
          content: s.content,
          metadata: s.metadata,
        }));

        for await (const chunk of ragChatStream(body.messages, retrievedDocs)) {
          send(controller, { type: "delta", text: chunk });
        }

        send(controller, { type: "done" });
      } catch (err) {
        send(controller, { type: "error", message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Model": env.LLM_MODEL,
    },
  });
}
