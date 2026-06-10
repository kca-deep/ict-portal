import { NextRequest } from "next/server";
import {
  ragChatStream,
  isRegulationSufficient,
  type ChatMessage,
  type RetrievedDoc,
} from "@/lib/ai/llm-router";
import { regulationSearch, type DocumentHit } from "@/lib/db/search";
import { rerank } from "@/lib/ai/rerank";
import { searchLaw } from "@/lib/law/search";
import { verifyCitations, type CitationVerdict } from "@/lib/law/verify";
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
  | { type: "routing"; route: "regulation" | "law"; score: number; laws?: { name: string; lawId: string }[] }
  | { type: "delta"; text: string }
  | { type: "citations"; data: CitationVerdict[]; hasHallucination: boolean }
  | { type: "done" }
  | { type: "error"; message: string };

// 검색 후보(최대 RETRIEVAL_TOP_K)를 Cohere로 재정렬해 관련도 상위 RERANK_TOP_K건만 반환.
// 재정렬 실패 시 RRF 점수 순 상위 RERANK_TOP_K건으로 안전하게 폴백.
async function topRerankedSources(
  query: string,
  hits: DocumentHit[],
): Promise<SourceChunk[]> {
  if (hits.length === 0) return [];

  const toSource = (h: DocumentHit, score: number): SourceChunk => ({
    id: h.id,
    title: h.title,
    source_ref: h.source_ref,
    content: h.content,
    metadata: h.metadata,
    score,
  });

  try {
    const byId = new Map(hits.map((h) => [h.id, h]));
    const reranked = await rerank(
      query,
      hits.map((h) => ({ id: h.id, text: h.content })),
      env.RERANK_TOP_K,
    );
    return reranked
      .map((r) => {
        const h = byId.get(r.id as number);
        return h ? toSource(h, r.score) : null;
      })
      .filter((s): s is SourceChunk => s !== null);
  } catch (err) {
    // 재정렬 실패를 조용히 삼키면 점수가 RRF(=낮은 %)로 표기되어 원인 추적이 어렵다.
    // 서버 로그로 드러내고 RRF 점수 순 상위 RERANK_TOP_K건으로 폴백한다.
    console.error("[chat] rerank failed, falling back to RRF order:", (err as Error).message);
    return hits
      .slice(0, env.RERANK_TOP_K)
      .map((h) => toSource(h, h.rrf_score));
  }
}

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
        // 1) 최대 RETRIEVAL_TOP_K(=30)건 후보 검색 → 2) Cohere 재정렬로 관련도 산출
        //    → 3) 상위 RERANK_TOP_K(=8)건만 LLM 근거로 사용
        const hits = await regulationSearch(query, env.RETRIEVAL_TOP_K);
        const sources = await topRerankedSources(query, hits);

        const retrievedDocs: RetrievedDoc[] = sources.map((s) => ({
          title: s.title,
          source_ref: s.source_ref,
          content: s.content,
          metadata: s.metadata,
        }));

        // 4) 관련도 분기 — 다음 두 조건 중 하나면 법제처 법령으로 보강:
        //    (a) 최상위 관련도 < 기준치(RELEVANCE_THRESHOLD)
        //    (b) 기준치 이상이지만 적합성 게이트가 "내부 규정만으로 답변 불가"로 판정
        //    (b)는 점수는 높지만 실제로는 규정에 답이 없는 회색지대를 잡는다.
        const maxScore = sources.length > 0 ? sources[0].score : 0;
        const belowThreshold = maxScore < env.RELEVANCE_THRESHOLD;
        let gateSufficient: boolean | null = null;
        if (!belowThreshold) {
          gateSufficient = await isRegulationSufficient(query, retrievedDocs);
        }
        const routedToLaw = belowThreshold || gateSufficient === false;

        let lawContext: string | undefined;
        let lawSources: SourceChunk[] = [];
        if (routedToLaw) {
          const law = await searchLaw(query);
          if (law.context) lawContext = law.context;
          // 법령을 참조문서로 변환 — 1위 법령엔 발췌 조문 본문, 나머지는 메타 요약.
          lawSources = law.refs.map((r, i) => ({
            id: -(i + 1),
            title: r.name,
            source_ref: `법제처 국가법령정보 · 법령ID ${r.lawId}`,
            content:
              i === 0 && law.articles.length > 0
                ? law.articles.join("\n\n")
                : `${r.name}\n공포일 ${r.promulgated}${r.ministry ? ` · 소관 ${r.ministry}` : ""}`,
            metadata: { kind: "law", lawId: r.lawId },
            score: 0,
          }));
        }
        const lawRefs = lawSources.map((s) => ({
          name: s.title ?? "",
          lawId: String((s.metadata as { lawId?: string }).lawId ?? ""),
        }));

        console.log(
          `[chat] route=${routedToLaw ? "law" : "regulation"} maxScore=${maxScore.toFixed(3)} ` +
            `threshold=${env.RELEVANCE_THRESHOLD} belowThreshold=${belowThreshold} gateSufficient=${gateSufficient} ` +
            `hits=${hits.length}` +
            (routedToLaw ? ` laws=[${lawRefs.map((r) => r.name).join(", ")}]` : " (법제처 미호출)"),
        );

        // 5) 답변을 먼저 스트리밍한다. (인용 검증용으로 본문을 누적)
        let answerText = "";
        for await (const chunk of ragChatStream(body.messages, retrievedDocs, lawContext)) {
          answerText += chunk;
          send(controller, { type: "delta", text: chunk });
        }

        // 6) 답변 완료 후 라우팅·참조문서를 전송 (UI: 답변 아래에 참조 패널 노출).
        //    법령 분기면 실제 근거인 법령을, 규정 분기면 규정 청크를 참조문서로 표시.
        const displayedSources = routedToLaw ? lawSources : sources;
        send(
          controller,
          routedToLaw
            ? { type: "routing", route: "law", score: maxScore, laws: lawRefs }
            : { type: "routing", route: "regulation", score: maxScore },
        );
        send(controller, { type: "sources", data: displayedSources });

        // 7) 법령 분기면 답변의 조문 인용을 법제처 DB와 교차 검증(환각 차단).
        //    답변이 이미 스트리밍 완료된 뒤라 체감 지연 없음. best-effort.
        if (routedToLaw) {
          try {
            const check = await verifyCitations(answerText);
            if (check.verdicts.length > 0) {
              send(controller, {
                type: "citations",
                data: check.verdicts,
                hasHallucination: check.hasHallucination,
              });
              console.log(
                `[chat] citations verified=${check.verdicts.filter((v) => v.status === "verified").length}/${check.verdicts.length} ` +
                  `hallucination=${check.hasHallucination}`,
              );
            }
          } catch (err) {
            console.error("[chat] citation verify failed:", (err as Error).message);
          }
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
