import { NextRequest } from "next/server";
import {
  ragChatStream,
  isInScope,
  isRegulationSufficient,
  type ChatMessage,
  type RetrievedDoc,
} from "@/lib/ai/llm-router";
import { regulationSearch, type DocumentHit } from "@/lib/db/search";
import { rerank } from "@/lib/ai/rerank";
import { searchAiLaw, formatArticle, type RetrievedLaws } from "@/lib/law/search";
import {
  searchDecisions,
  getDecisionText,
  type DecisionRef,
  type DecisionText,
  type DecisionDomain,
} from "@/lib/law/decisions";
import {
  verifyCitations,
  type CitationVerdict,
  type CitationCheck,
} from "@/lib/law/verify";
import { env } from "@/lib/env";
import { checkRateLimit } from "@/lib/security/ratelimit";
import { logQuery, type QueryLogRow } from "@/lib/db/query-log";

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

const DECISION_LABEL: Record<DecisionDomain, string> = {
  prec: "판례",
  detc: "헌재결정",
};

// 판례 본문을 참조문서 패널용 SourceChunk 로 변환 (kind=precedent).
function toPrecedentSource(
  r: DecisionRef,
  t: DecisionText,
  i: number,
): SourceChunk {
  const parts = [
    t.summary && `**판시사항**\n\n${t.summary}`,
    t.holding && `**판결요지**\n\n${t.holding}`,
    t.refStatutes && `**참조조문**\n\n${t.refStatutes}`,
  ].filter(Boolean) as string[];
  return {
    // 법령 소스(-(i+1))와 겹치지 않는 별도 음수 대역.
    id: -(100 + i),
    title: `${r.caseName}${r.caseNo ? ` (${r.caseNo})` : ""}`,
    source_ref: `법제처 ${DECISION_LABEL[r.domain]} · ${r.court}${r.date ? ` ${r.date}` : ""} · 일련번호 ${r.serial}`,
    content: parts.length > 0 ? parts.join("\n\n") : r.caseName,
    metadata: { kind: "precedent", serial: r.serial, domain: r.domain },
    score: 0,
  };
}

// 판례 발췌를 LLM <context> 주입용 텍스트로 구성.
function buildPrecedentContext(
  refs: DecisionRef[],
  texts: DecisionText[],
): string {
  const lines = refs.map((r, i) => {
    const t = texts[i] ?? {};
    const head = `${i + 1}. ${r.caseName}${r.caseNo ? ` (${r.caseNo})` : ""} — ${r.court}${r.date ? ` ${r.date}` : ""}`;
    const body = [
      t.summary && `판시사항: ${t.summary}`,
      t.holding && `판결요지: ${t.holding}`,
    ]
      .filter(Boolean)
      .join("\n   ");
    return body ? `${head}\n   ${body}` : head;
  });
  return `[관련 판례]\n${lines.join("\n")}`;
}

// 클라이언트 IP 추출. 프록시 체인 첫 홉(x-forwarded-for) 우선, 없으면 x-real-ip 로
// 폴백한다. Vercel/Next 은 x-forwarded-for 를 세팅하며(로컬 dev 는 소켓 기준 ::1),
// 일부 프록시는 x-real-ip 만 준다. 빈 문자열은 undefined 로 정규화(레이트리밋·로그 일관).
function clientIpFrom(req: NextRequest): string | undefined {
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff;
  const real = req.headers.get("x-real-ip")?.trim();
  return real || undefined;
}

function isValidMessages(value: unknown): value is ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.length > env.MAX_TURNS) return false;
  return value.every(
    (m) =>
      m &&
      typeof m === "object" &&
      (m as ChatMessage).role !== undefined &&
      ((m as ChatMessage).role === "user" ||
        (m as ChatMessage).role === "assistant") &&
      typeof (m as ChatMessage).content === "string" &&
      (m as ChatMessage).content.trim().length > 0 &&
      (m as ChatMessage).content.length <= env.MAX_CONTENT_CHARS,
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

  // 레이트리밋(활성 시). 비활성이면 checkRateLimit 이 즉시 통과(기존 동작 유지).
  const clientIp = clientIpFrom(req);
  if (!(await checkRateLimit(clientIp)).ok) {
    return new Response("rate limit exceeded", { status: 429 });
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
      // 감사 로그(query_log) 누적 버퍼. 성공/실패 어느 쪽이든 finally 에서 한 번
      // fire-and-forget 으로 적재한다(응답 스트림 종료를 지연시키지 않음).
      const tStart = Date.now();
      let ttftMs: number | null = null;
      const logRow: QueryLogRow = {
        query,
        ip: clientIp ?? null,
        message_count: body.messages.length,
      };
      try {
        // 1) 최대 RETRIEVAL_TOP_K(=30)건 후보 검색 → 2) Cohere 재정렬로 관련도 산출
        //    → 3) 상위 RERANK_TOP_K(=8)건만 LLM 근거로 사용
        const tRetrieval = Date.now();
        const hits = await regulationSearch(query, env.RETRIEVAL_TOP_K);
        logRow.retrieval_ms = Date.now() - tRetrieval;
        const tRerank = Date.now();
        const sources = await topRerankedSources(query, hits);
        logRow.rerank_ms = Date.now() - tRerank;

        const retrievedDocs: RetrievedDoc[] = sources.map((s) => ({
          title: s.title,
          source_ref: s.source_ref,
          content: s.content,
          metadata: s.metadata,
        }));

        // 4) 관련도 분기 — 내부 규정 최상위 관련도(maxScore)로 규정/법령을 가른다.
        //    · maxScore ≥ RELEVANCE_GRAY_UPPER : 자신있는 규정 근거 → 규정 분기(게이트 생략)
        //    · RELEVANCE_THRESHOLD ≤ maxScore < GRAY_UPPER : 회색지대 → LLM 적합성 게이트로
        //      "규정만으로 질의 핵심에 답 가능?"을 재판정(NO면 법령). 노이즈 규정청크가
        //      임계치를 근소하게(예: 0.35 vs 0.33) 넘겨 법령 질의를 규정으로 오라우팅하던
        //      문제를 차단한다 — 단, 게이트는 회색지대에서만 호출해 청크 변동 민감성을 제한.
        //    · maxScore < RELEVANCE_THRESHOLD : 규정 근거 없음 → (범위 내면) 법령 분기
        const maxScore = sources.length > 0 ? sources[0].score : 0;
        const belowThreshold = maxScore < env.RELEVANCE_THRESHOLD;
        const inGrayZone =
          !belowThreshold && maxScore < env.RELEVANCE_GRAY_UPPER;

        // 회색지대 적합성 게이트: 규정 발췌만으로 질의 핵심에 답할 근거가 없으면(NO) 법령으로.
        // 자신있는 고득점(≥ GRAY_UPPER) 규정은 게이트를 호출하지 않는다. 게이트 실패 시
        // isRegulationSufficient 가 true(충분)로 폴백 → 규정 유지(게이트 장애가 답변을 막지 않음).
        const grayZoneInsufficient = inGrayZone
          ? !(await isRegulationSufficient(query, retrievedDocs))
          : false;

        // 범위 게이트: 규정 관련도가 낮은 질의(잡담 포함)는 법령 분기 전에 서비스
        // 범위(법령·규정·행정·공공기금)인지 확인한다. 범위 밖이면 법령·판례 검색과
        // 참조문서를 모두 생략하고 정중한 거절만 스트리밍한다. 회색지대(규정에 일부
        // 관련 있어 임계치 통과)는 범위 내로 보고 범위 게이트를 생략한다.
        const outOfScope = belowThreshold ? !(await isInScope(query)) : false;

        // 법령 분기: 규정 근거 없음(belowThreshold) 또는 회색지대 게이트가 불충분 판정.
        // 범위 밖이면 어느 쪽도 아님(거절).
        const routedToLaw =
          !outOfScope && (belowThreshold || grayZoneInsufficient);

        // 분기·관련도·게이트 신호 기록(검색 후보는 [{id,score}] 로 경량 저장).
        logRow.route = outOfScope ? "out_of_scope" : routedToLaw ? "law" : "regulation";
        logRow.top_score = maxScore;
        logRow.below_threshold = belowThreshold;
        logRow.gate_sufficient = inGrayZone ? !grayZoneInsufficient : null;
        logRow.out_of_scope = outOfScope;
        logRow.retrieved = sources.map((s) => ({ id: s.id, score: s.score }));
        logRow.retrieved_doc_ids = sources.filter((s) => s.id > 0).map((s) => s.id);

        let lawContext: string | undefined;
        // 통합: 검색(searchAiLaw)은 LLM 근거(lawContext) + 인용 검증 재사용(retrieved)
        // 전용. 참조문서 표시는 더 이상 검색 결과를 직접 쓰지 않고, 답변이 실제 인용·검증한
        // 조문(citationSources)만 단일 소스로 쓴다 — "표시≠사용"·노이즈 폴백 제거.
        let lawRetrieved: RetrievedLaws | undefined;
        let lawRefs: { name: string; lawId: string }[] = [];
        let precedentSources: SourceChunk[] = [];
        if (routedToLaw) {
          // 법령과 판례를 동시 조회 (둘 다 법제처 — 병렬로 응답 전 지연 최소화).
          const [law, precRefs] = await Promise.all([
            searchAiLaw(query),
            searchDecisions(query, "prec", 2),
          ]);
          if (law.context) lawContext = law.context;
          lawRetrieved = law.retrieved;
          // 검색이 찾은 법령은 라우팅 표시(routing.laws)에만 쓴다(참조 카드 아님).
          lawRefs = law.refs.map((r) => ({ name: r.name, lawId: r.lawId }));

          // 상위 판례 본문을 회수해 참조문서 + 컨텍스트로 보강 (best-effort).
          if (precRefs.length > 0) {
            const texts = await Promise.all(
              precRefs.map((r) => getDecisionText(r.serial, r.domain)),
            );
            // 판례 scope creep 방지: 판시·판결요지를 질의로 재정렬해 관련도 낮은 판례 제외.
            // 무관 판례(예: "전담기관"에 공직선거법위반)가 참조문서로 새는 것을 차단.
            const judged = await rerank(
              query,
              precRefs.map((r, i) => ({
                id: i,
                text: `${r.caseName}\n${texts[i]?.summary ?? ""}\n${texts[i]?.holding ?? ""}`,
              })),
              precRefs.length,
            ).catch(() => precRefs.map((_, i) => ({ id: i, score: 1 }))); // 재정렬 실패 시 보존
            const keep = new Set(
              judged.filter((j) => j.score >= env.RELEVANCE_THRESHOLD).map((j) => j.id as number),
            );
            const keptRefs = precRefs.filter((_, i) => keep.has(i));
            const keptTexts = texts.filter((_, i) => keep.has(i));
            precedentSources = keptRefs.map((r, i) => toPrecedentSource(r, keptTexts[i], i));
            if (keptRefs.length > 0) {
              const precBlock = buildPrecedentContext(keptRefs, keptTexts);
              lawContext = [lawContext, precBlock].filter(Boolean).join("\n\n");
            }
          }
        }

        logRow.law_refs = lawRefs;

        console.log(
          `[chat] route=${outOfScope ? "out_of_scope" : routedToLaw ? "law" : "regulation"} maxScore=${maxScore.toFixed(3)} ` +
            `threshold=${env.RELEVANCE_THRESHOLD} grayUpper=${env.RELEVANCE_GRAY_UPPER} ` +
            `belowThreshold=${belowThreshold} grayZone=${inGrayZone}${inGrayZone ? `(insufficient=${grayZoneInsufficient})` : ""} ` +
            `hits=${hits.length}` +
            (routedToLaw ? ` laws=[${lawRefs.map((r) => r.name).join(", ")}]` : " (법제처 미호출)"),
        );

        // 5) 답변을 먼저 스트리밍한다. (인용 검증용으로 본문을 누적)
        //    범위 밖이면 어떤 근거도 주지 않아, 시스템 프롬프트의 범위 밖 거절만 나오게 한다.
        let answerText = "";
        // law 분기에선 규정 청크를 주입하지 않는다(진짜 이분법). 규정 본문이 답변에
        // 섞이면서 출처는 법령만 표시되던 "표시≠사용" 불일치를 제거.
        const answerDocs = outOfScope || routedToLaw ? [] : retrievedDocs;
        const answerLawContext = outOfScope ? undefined : lawContext;
        const tLlm = Date.now();
        // 제너레이터를 수동으로 구동해 텍스트 청크를 스트리밍하고, 종료 시 return 값
        // (토큰 사용량)을 회수한다. for-await 는 return 값을 버리므로 수동 반복 사용.
        const gen = ragChatStream(body.messages, answerDocs, answerLawContext);
        let step = await gen.next();
        while (!step.done) {
          if (ttftMs === null) ttftMs = Date.now() - tStart; // 첫 토큰까지 지연
          answerText += step.value;
          send(controller, { type: "delta", text: step.value });
          step = await gen.next();
        }
        const usage = step.value;
        logRow.llm_ms = Date.now() - tLlm;
        logRow.answer = answerText;
        logRow.answer_truncated = false;
        logRow.llm_model = env.LLM_MODEL;
        logRow.tokens_in = usage?.input ?? null;
        logRow.tokens_out = usage?.output ?? null;

        // 6) 법령 분기면 답변의 조문 인용을 법제처 DB와 교차 검증한다(환각 차단).
        //    검증은 "답변이 실제 인용한 조문"을 본문과 함께 돌려주므로, 검색(aiSearch)이
        //    끌어온 곁가지 조문 대신 이 인용 조문을 참조문서로 보여 줄 수 있다
        //    (참조-답변 불일치 해소). 답변이 이미 스트리밍 완료된 뒤라 체감 지연 적음.
        let citationCheck: CitationCheck | null = null;
        if (routedToLaw) {
          try {
            // 검색이 이미 회수한 조문(lawRetrieved)을 재사용 — 인용이 검색 결과에 있으면
            // 법제처 재조회 없이 검증, 없을 때만 법제처 조회(누락 보강·환각 판정).
            citationCheck = await verifyCitations(answerText, lawRetrieved);
          } catch (err) {
            console.error("[chat] citation verify failed:", (err as Error).message);
          }
        }

        // 답변이 인용했고 법제처에 실존이 확인된 조문을, 그 본문과 함께 참조 카드로.
        // 참조 카드는 이 단일 소스만 쓴다 — 검색 후보(노이즈)로의 폴백 없음. 관련도(score)는
        // 법령 카드 UI에 미표시(내부 정렬용 0)라 별도 점수 매핑을 두지 않는다.
        const citationSources: SourceChunk[] = (citationCheck?.verdicts ?? [])
          .filter((v) => v.status === "verified" && v.body)
          .map((v, i) => ({
            id: -(200 + i),
            title: v.lawName,
            source_ref: `법제처 국가법령정보 · 법령ID ${v.lawId ?? ""}`,
            content: formatArticle(v.article, v.articleTitle ?? "", v.body!),
            metadata: { kind: "law", lawId: v.lawId, article: v.article, cited: true },
            score: 0,
          }));

        // 인용 검증 신호 기록(본문 body 는 제외해 로그를 가볍게).
        if (citationCheck) {
          const verdicts = citationCheck.verdicts;
          logRow.citation_count = verdicts.length;
          logRow.citation_verified_count = verdicts.filter(
            (v) => v.status === "verified",
          ).length;
          logRow.citation_verified = !citationCheck.hasHallucination;
          logRow.has_hallucination = citationCheck.hasHallucination;
          logRow.cited_law_refs = verdicts.map(({ body: _body, ...v }) => v);
        }

        // 7) 라우팅·참조문서 전송. 법령 분기는 답변이 인용·검증한 조문만 표시(검색 후보로
        //    폴백하지 않음 — 인용이 0건이면 판례만, 그것도 없으면 빈 표시). 규정 분기면
        //    규정 청크를. 범위 밖이면 참조문서를 일절 표시하지 않는다(빈 배열).
        const displayedSources = outOfScope
          ? []
          : routedToLaw
            ? [...citationSources, ...precedentSources]
            : sources;
        if (!outOfScope) {
          send(
            controller,
            routedToLaw
              ? { type: "routing", route: "law", score: maxScore, laws: lawRefs }
              : { type: "routing", route: "regulation", score: maxScore },
          );
        }
        send(controller, { type: "sources", data: displayedSources });

        // 8) 인용 검증 결과(✓/✗/⚠)를 전송(UI 환각 경고용). 본문(body)은 참조 카드가
        //    이미 싣고 있으니 이벤트에선 떼어 가볍게 보낸다.
        if (citationCheck && citationCheck.verdicts.length > 0) {
          send(controller, {
            type: "citations",
            data: citationCheck.verdicts.map(({ body: _body, ...v }) => v),
            hasHallucination: citationCheck.hasHallucination,
          });
          console.log(
            `[chat] citations verified=${citationCheck.verdicts.filter((v) => v.status === "verified").length}/${citationCheck.verdicts.length} ` +
              `hallucination=${citationCheck.hasHallucination} citedSources=${citationSources.length}`,
          );
        }

        send(controller, { type: "done" });
      } catch (err) {
        logRow.error_code = (err as Error).name || "stream_error";
        send(controller, { type: "error", message: (err as Error).message });
      } finally {
        logRow.ttft_ms = ttftMs;
        logRow.total_ms = Date.now() - tStart;
        // 적재 실패가 응답을 막지 않도록 await 하지 않는다(내부에서 예외 삼킴).
        void logQuery(logRow);
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
