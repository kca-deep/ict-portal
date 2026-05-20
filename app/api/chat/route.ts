import { NextRequest } from "next/server";
import { hybridSearch } from "@/lib/db/search";
import { rerank } from "@/lib/ai/rerank";
import { answerStream } from "@/lib/ai/llm-router";
import { getSupabaseAdmin } from "@/lib/db/supabase";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;

type ChatRequest = {
  query: string;
  session_id?: string;
  user_id?: string;
};

export async function POST(req: NextRequest) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return new Response("invalid json body", { status: 400 });
  }

  const { query, session_id, user_id } = body;
  if (!query?.trim()) {
    return new Response("query required", { status: 400 });
  }

  const t0 = Date.now();

  // Step 1: Hybrid search (BM25 + vector + RRF)
  let candidates;
  try {
    candidates = await hybridSearch(query, env.RETRIEVAL_TOP_K);
  } catch (err) {
    return new Response(`retrieval failed: ${(err as Error).message}`, { status: 500 });
  }
  const tRetrieval = Date.now() - t0;

  // Step 2: Rerank to top-K
  const rerankInput = candidates.map((c) => ({
    id: c.id,
    text: `${c.title ?? ""}\n${c.content}`.slice(0, 4000),
    metadata: { source_ref: c.source_ref, ...c.metadata },
  }));
  const tRerankStart = Date.now();
  const reranked = await rerank(query, rerankInput, env.RERANK_TOP_K);
  const tRerank = Date.now() - tRerankStart;

  // Step 3: 컨텍스트로 사용할 상위 문서 매핑
  const topDocs = reranked
    .map((r) => candidates.find((c) => c.id === r.id))
    .filter((d): d is NonNullable<typeof d> => d != null)
    .map((d) => ({
      title: d.title,
      source_ref: d.source_ref,
      content: d.content,
      metadata: d.metadata,
    }));

  // TODO: 법령 도구 (lib/law/) 호출 결과를 lawContext 로 결합 (PoC 단계 이후 추가)

  // Step 4: LLM 스트리밍 + 로그 적재
  const tLlmStart = Date.now();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let fullAnswer = "";
      try {
        for await (const chunk of answerStream({ query, retrievedDocs: topDocs })) {
          fullAnswer += chunk;
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(`\n\n[ERROR] ${(err as Error).message}`)
        );
      } finally {
        const tLlm = Date.now() - tLlmStart;
        const totalMs = Date.now() - t0;

        getSupabaseAdmin()
          .from("query_log")
          .insert({
            session_id: session_id ?? null,
            user_id: user_id ?? null,
            query,
            answer: fullAnswer,
            retrieved_doc_ids: reranked.map((r) => Number(r.id)),
            llm_model: env.LLM_MODEL,
            retrieval_ms: tRetrieval,
            rerank_ms: tRerank,
            llm_ms: tLlm,
            total_ms: totalMs,
          })
          .then(({ error }) => {
            if (error) console.error("query_log insert failed:", error.message);
          });

        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Model": env.LLM_MODEL,
    },
  });
}
