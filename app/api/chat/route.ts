import { NextRequest } from "next/server";
import {
  ragChatStream,
  isInScope,
  decomposeIntents,
  type ChatMessage,
  type RetrievedDoc,
} from "@/lib/ai/llm-router";
import { regulationSearch, type DocumentHit } from "@/lib/db/search";
import { rerank } from "@/lib/ai/rerank";
import {
  fetchAiLawCandidates,
  formatArticle,
  articleKeyOf,
  mergeRetrievedLaws,
  type AiArticleHit,
  type AiLawCandidates,
} from "@/lib/law/search";
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
import { checkBotId } from "botid/server";
import { env } from "@/lib/env";
import { checkRateLimit } from "@/lib/security/ratelimit";
import { checkCostBudget, recordTokens } from "@/lib/security/cost-guard";
import { logQuery, type QueryLogRow } from "@/lib/db/query-log";

export const runtime = "nodejs";
export const maxDuration = 300;

type ChatRequest = {
  messages: ChatMessage[];
  session_id?: string;
};

// 클라이언트가 보내는 세션 식별자 검증용(query_log.session_id 는 uuid 타입).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  | { type: "citations"; data: CitationVerdict[]; hasHallucination: boolean }
  | { type: "meta"; queryId: number }
  | { type: "done" }
  | { type: "error"; message: string };

// 통합 리랭킹 풀의 후보 한 건 — 내부 규정 청크 또는 법제처 법령 조문.
type PoolItem =
  | { kind: "regulation"; hit: DocumentHit }
  | { kind: "law"; hit: AiArticleHit };

type RankedItem = { item: PoolItem; score: number };
// 의도 분해 경로의 선발 항목 — 어느 의도 질의가 이 근거를 뽑았는지 라벨을 남긴다.
type RankedPick = RankedItem & { intent?: string };

// 후보 중복 제거 키 — 규정은 문서 id, 법령은 법령ID+조문키.
const poolKey = (p: PoolItem) =>
  p.kind === "regulation"
    ? `reg:${p.hit.id}`
    : `law:${p.hit.lawId}:${articleKeyOf(p.hit)}`;

// 원질의 후보를 의도 풀에 공용 합류시킬 때의 중복 제거 병합.
function mergeRegHits(primary: DocumentHit[], extra: DocumentHit[]): DocumentHit[] {
  const seen = new Set(primary.map((h) => h.id));
  return [...primary, ...extra.filter((h) => !seen.has(h.id))];
}
function mergeLawHits(primary: AiArticleHit[], extra: AiArticleHit[]): AiArticleHit[] {
  const key = (h: AiArticleHit) => `${h.lawId}:${articleKeyOf(h)}`;
  const seen = new Set(primary.map(key));
  return [...primary, ...extra.filter((h) => !seen.has(key(h)))];
}

// 참조문서(주입분) 구성으로 route 를 분기한다 — 관리자 대시보드 분기 분포·필터의
// 변별력 확보. 규정만=regulation, 법령만=law, 섞이면=unified. 판례는 법령이 있을 때만
// 붙으므로 별도 분기 축이 아니다(법령 쪽에 흡수). 근거 0건(범위 내)은 중립적으로 unified.
function routeFromComposition(
  regCount: number,
  lawCount: number,
): "unified" | "regulation" | "law" {
  if (regCount > 0 && lawCount > 0) return "unified";
  if (lawCount > 0) return "law";
  if (regCount > 0) return "regulation";
  return "unified";
}

// 규정 청크 + 법령 조문을 한 풀에서 Cohere로 1회 재정렬해 상위 RERANK_TOP_K건 반환
// (내림차순). 소스 간 동일 잣대 점수라 규정·법령이 순수 점수순으로 경쟁한다.
// 재정렬 실패 시 교차 소스 점수가 없으므로 법령을 버리고 규정 RRF 순으로 폴백.
async function rerankUnifiedPool(
  query: string,
  regHits: DocumentHit[],
  lawHits: AiArticleHit[],
  topN: number = env.RERANK_TOP_K,
): Promise<RankedItem[]> {
  const pool: PoolItem[] = [
    ...regHits.map((hit): PoolItem => ({ kind: "regulation", hit })),
    ...lawHits.map((hit): PoolItem => ({ kind: "law", hit })),
  ];
  if (pool.length === 0) return [];

  try {
    const reranked = await rerank(
      query,
      pool.map((p, i) => ({
        id: i,
        text:
          p.kind === "regulation"
            ? p.hit.content
            : `${p.hit.name} ${p.hit.articleTitle}\n${p.hit.body}`,
      })),
      topN,
    );
    return reranked.map((r) => ({ item: pool[r.id as number], score: r.score }));
  } catch (err) {
    // 재정렬 실패를 조용히 삼키면 점수가 RRF(=낮은 %)로 표기되어 원인 추적이 어렵다.
    // 서버 로그로 드러내고 규정 RRF 순 상위 topN건으로 폴백한다(법령 조문은
    // 규정과 비교 가능한 점수가 없어 안전하게 제외).
    console.error(
      "[chat] 통합 rerank 실패 — 규정 RRF 순 폴백(법령 제외):",
      (err as Error).message,
    );
    return regHits
      .slice(0, topN)
      .map((hit) => ({ item: { kind: "regulation", hit } as PoolItem, score: hit.rrf_score }));
  }
}

const DECISION_LABEL: Record<DecisionDomain, string> = {
  prec: "판례",
  detc: "헌재결정",
};

// 판례 본문을 참조문서 패널용 SourceChunk 로 변환 (kind=precedent).
// score 는 판례 필터(Cohere)의 관련도 — 0 이면 UI 가 % 표시를 생략한다(필터 실패 폴백).
function toPrecedentSource(
  r: DecisionRef,
  t: DecisionText,
  i: number,
  score: number,
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
    score,
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
  // 봇 차단(Vercel BotID) — 자동화 트래픽을 처리·과금 전에 거른다. 로컬/미배포
  // 환경에서는 SDK 가 통과로 동작한다. 클라이언트 신호는 layout 의 <BotIdClient> 가 수집.
  const bot = await checkBotId();
  if (bot.isBot) {
    return new Response("forbidden", { status: 403 });
  }

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

  // 레이트리밋 + 비용 예산(활성 시). 무인증 유료 엔드포인트의 핵심 방어선 —
  // 요청 수(분당·일일)와 실제 토큰 소비(일일)를 각각 통제한다. 프로덕션은 저장소
  // 오류 시 fail-closed(비용 보호 우선). 비활성이면 즉시 통과(로컬 개발).
  const clientIp = clientIpFrom(req);
  if (!(await checkRateLimit(clientIp)).ok) {
    return new Response("rate limit exceeded", { status: 429 });
  }
  if (!(await checkCostBudget(clientIp)).ok) {
    return new Response("daily budget exceeded", { status: 429 });
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
      let logged = false;
      const sessionId =
        typeof body.session_id === "string" && UUID_RE.test(body.session_id)
          ? body.session_id
          : null;
      const logRow: QueryLogRow = {
        query,
        ip: clientIp ?? null,
        message_count: body.messages.length,
        session_id: sessionId,
      };
      try {
        // 1) 통합 검색 — 내부 규정(최대 RETRIEVAL_TOP_K=30) + 법제처 법령 조문(≤50)
        //    + 판례 목록(투기적, 주입분에 법령이 있을 때만 소비) + 의도 분해 게이트를
        //    전부 동시에 발사한다(투기적 병렬 — 대부분의 단일 의도 질의는 분해 결과를
        //    기다릴 필요가 없어 TTFT 증가가 없다). 법령·판례·분해는 best-effort.
        const tRetrieval = Date.now();
        const [hits, lawCand, precRefs, intents] = await Promise.all([
          regulationSearch(query, env.RETRIEVAL_TOP_K),
          fetchAiLawCandidates(query),
          searchDecisions(query, "prec", 2),
          decomposeIntents(query),
        ]);

        // 1-b) 복합 의도(2개 이상)면 의도별 검색을 추가 발사. 검색 대상이 다른 목적이
        //    한 질의에 섞이면 지배 의도가 법제처 의미검색을 독점해(예: 기금 어휘가
        //    회생법을 밀어냄) 부차 의도 법령이 후보에 못 들기 때문에, 의도 단위로
        //    후보를 회수한다. 원질의 후보는 각 의도 풀에 공용 합류(리콜 보강).
        type IntentPool = { intent: string; reg: DocumentHit[]; law: AiLawCandidates };
        let intentPools: IntentPool[] = [];
        if (intents.length >= 2) {
          intentPools = await Promise.all(
            intents.map(async (intent) => {
              const [reg, law] = await Promise.all([
                regulationSearch(intent, env.RETRIEVAL_TOP_K),
                fetchAiLawCandidates(intent),
              ]);
              return { intent, reg, law };
            }),
          );
        }
        logRow.retrieval_ms = Date.now() - tRetrieval;

        // 2) 통합 리랭킹 — 규정 청크와 법령 조문을 한 풀·같은 잣대(Cohere)로 재정렬.
        //    · 단일 의도(기본): 원질의 기준 1회 재정렬 → 문턱 이상 top-K (기존 경로 그대로)
        //    · 복합 의도: 의도별 풀을 "그 의도 질의" 기준으로 재정렬 — 긴 복합 질의
        //      전체와 대조하면 부차 의도 조문이 구조적으로 저평가되는 것(실측 0.05~0.16)을
        //      의도 기준 채점으로 복원한다. 선발은 B안: 의도별 상위 2건은 완화 문턱
        //      (RELEVANCE_INTENT_FLOOR), 그 밖은 기본 문턱. 의도별 상한을 두고
        //      의도 순서로 인터리브 병합(각 의도의 대표성 보장, 교차 중복은 고점 유지).
        const tRerank = Date.now();
        let picked: RankedPick[];
        let maxScore: number;
        if (intentPools.length === 0) {
          const ranked = await rerankUnifiedPool(query, hits, lawCand.hits);
          maxScore = ranked.length > 0 ? ranked[0].score : 0;
          picked = ranked.filter((r) => r.score >= env.RELEVANCE_THRESHOLD);
        } else {
          const perIntentCap = Math.max(
            2,
            Math.ceil(env.RERANK_TOP_K / intentPools.length),
          );
          const rankedPerIntent = await Promise.all(
            intentPools.map(async (p): Promise<RankedPick[]> => {
              // topN 을 넉넉히(20) 받아 명시 법령 한정 후에도 선발 창이 남게 한다.
              const ranked = await rerankUnifiedPool(
                p.intent,
                mergeRegHits(p.reg, hits),
                mergeLawHits(p.law.hits, lawCand.hits),
                Math.max(env.RERANK_TOP_K, 20),
              );

              // 명시 법령 한정 — 의도 질의에 법령 '정식 명칭'이 들어 있으면(분해기가
              // 대상 법령을 지목), 이 의도의 법령 후보를 그 법령(본법 + 시행령·시행규칙)
              // 조문으로 한정한다. 그 법령을 본문에서 '언급만' 하는 곁가지 조문(예: 회생
              // 질의에 조특법 증권거래세 면제 — "회생계획에 따른 …" 문구의 어휘 밀도로
              // 0.88을 받아 상위 독점)이 본체 법령을 밀어내는 것을 차단. 점수 보정 없이
              // 후보 한정으로만 개입(표시 점수 정직성 유지). 규정 청크는 영향 없음.
              const normIntent = p.intent.replace(/\s+/g, "");
              const namedInIntent = (h: AiArticleHit) => {
                const base = h.name
                  .replace(/\s+/g, "")
                  .replace(/(시행령|시행규칙)$/, "");
                return base.length >= 2 && normIntent.includes(base);
              };
              const intentNamesLaw = ranked.some(
                (r) => r.item.kind === "law" && namedInIntent(r.item.hit),
              );
              const scoped = intentNamesLaw
                ? ranked.filter(
                    (r) => r.item.kind !== "law" || namedInIntent(r.item.hit),
                  )
                : ranked;

              // B안 선발: (한정 후) 상위 2건은 완화 문턱, 그 밖은 기본 문턱.
              return scoped
                .filter(
                  (r, idx) =>
                    r.score >=
                    (idx < 2 ? env.RELEVANCE_INTENT_FLOOR : env.RELEVANCE_THRESHOLD),
                )
                .slice(0, perIntentCap)
                .map((r) => ({ ...r, intent: p.intent }));
            }),
          );
          maxScore = Math.max(0, ...rankedPerIntent.map((l) => l[0]?.score ?? 0));
          // 인터리브 병합 — i번째 라운드에 각 의도의 i순위를 차례로. 같은 문서가
          // 여러 의도에서 뽑히면 첫 등장 위치를 지키되 점수·의도는 높은 쪽을 남긴다.
          const byKey = new Map<string, RankedPick>();
          const order: string[] = [];
          for (let i = 0; ; i++) {
            let any = false;
            for (const list of rankedPerIntent) {
              const p = list[i];
              if (!p) continue;
              any = true;
              const k = poolKey(p.item);
              const prev = byKey.get(k);
              if (!prev) {
                byKey.set(k, p);
                order.push(k);
              } else if (p.score > prev.score) {
                byKey.set(k, p);
              }
            }
            if (!any) break;
          }
          // 전역 캡 — 의도별 상한 인터리브가 RERANK_TOP_K 를 넘지 않도록 최종 절단
          //  (참조문서 = 리랭크 상위 RERANK_TOP_K건 원칙을 복합 의도 경로에도 강제).
          picked = order.map((k) => byKey.get(k)!).slice(0, env.RERANK_TOP_K);
        }
        logRow.rerank_ms = Date.now() - tRerank;

        // 3) 관련도 판정 — 근거 없음 = 선발 0건. (완화 문턱 선발이 있는데 maxScore
        //    비교로 범위 게이트에 새는 모순 방지. 단일 의도 경로에선 maxScore<문턱과
        //    동치라 기존 동작 불변.) belowThreshold 는 로그 신호로만 유지.
        const belowThreshold = maxScore < env.RELEVANCE_THRESHOLD;
        const injected = picked;

        // 범위 게이트: 근거가 전혀 없는 질의(잡담 포함)만 서비스 범위(법령·규정·
        // 행정·공공기금)인지 확인한다. 범위 밖이면 근거 미주입 + 참조문서 생략으로
        // 정중한 거절만 스트리밍한다.
        const outOfScope = injected.length === 0 ? !(await isInScope(query)) : false;

        // 4) 주입분 → LLM 근거 + 참조 카드 동시 구성(표시=입력 단일 원칙).
        //    규정 청크는 [내부 규정] 섹션(retrievedDocs), 법령 조문은 [법령·판례]
        //    섹션(lawContext)으로. 카드 순서는 통합 점수순 그대로(규정·법령 혼합).
        const sources: SourceChunk[] = [];
        const retrievedDocs: RetrievedDoc[] = [];
        const lawParts: string[] = [];
        const lawRefs: { name: string; lawId: string }[] = [];
        for (const { item, score, intent } of injected) {
          if (item.kind === "regulation") {
            const h = item.hit;
            // 복합 의도면 어느 의도가 이 근거를 뽑았는지 라벨(관리자 로그·디버깅용).
            const metadata = intent ? { ...h.metadata, intent } : h.metadata;
            sources.push({
              id: h.id,
              title: h.title,
              source_ref: h.source_ref,
              content: h.content,
              metadata,
              score,
            });
            retrievedDocs.push({
              title: h.title,
              source_ref: h.source_ref,
              content: h.content,
              metadata,
            });
          } else {
            const h = item.hit;
            const articleKey = articleKeyOf(h);
            // 법령 카드 id 는 규정(양수)·판례(-(100+i))와 겹치지 않는 음수 대역.
            sources.push({
              id: -(200 + lawParts.length),
              title: h.name,
              source_ref: `법제처 국가법령정보 · 법령ID ${h.lawId}`,
              content: formatArticle(articleKey, h.articleTitle, h.body),
              metadata: {
                kind: "law",
                lawId: h.lawId,
                article: articleKey,
                ...(intent ? { intent } : {}),
              },
              score,
            });
            lawParts.push(
              `${lawParts.length + 1}. ${h.name} (법령ID ${h.lawId}, 관련도 ${Math.round(score * 100)}%)\n${formatArticle(articleKey, h.articleTitle, h.body)}`,
            );
            if (!lawRefs.some((r) => r.lawId === h.lawId)) {
              lawRefs.push({ name: h.name, lawId: h.lawId });
            }
          }
        }
        let lawContext = lawParts.length > 0 ? lawParts.join("\n\n") : undefined;

        // 판례 보강 — 주입분에 법령 조문이 있을 때만 본문을 회수한다(순수 규정 질의의
        // 판례 왕복·노이즈 차단). 판시·판결요지를 질의로 재정렬해 관련도 낮은 판례 제외.
        let precedentSources: SourceChunk[] = [];
        if (!outOfScope && lawParts.length > 0 && precRefs.length > 0) {
          const texts = await Promise.all(
            precRefs.map((r) => getDecisionText(r.serial, r.domain)),
          );
          // 필터 실패 시 판례를 보존하되 score=0 으로(UI 는 0이면 % 미표시 — 미검증
          // 점수를 100%처럼 표기하지 않는다).
          let judgeFailed = false;
          const judged = await rerank(
            query,
            precRefs.map((r, i) => ({
              id: i,
              text: `${r.caseName}\n${texts[i]?.summary ?? ""}\n${texts[i]?.holding ?? ""}`,
            })),
            precRefs.length,
          ).catch(() => {
            judgeFailed = true;
            return precRefs.map((_, i) => ({ id: i, score: 0 }));
          });
          const keep = new Map(
            judged
              .filter((j) => judgeFailed || j.score >= env.RELEVANCE_THRESHOLD)
              .map((j) => [j.id as number, j.score]),
          );
          const keptIdx = precRefs.map((_, i) => i).filter((i) => keep.has(i));
          const keptRefs = keptIdx.map((i) => precRefs[i]);
          const keptTexts = keptIdx.map((i) => texts[i]);
          precedentSources = keptIdx.map((origIdx, i) =>
            toPrecedentSource(precRefs[origIdx], texts[origIdx], i, keep.get(origIdx) ?? 0),
          );
          if (keptRefs.length > 0) {
            const precBlock = buildPrecedentContext(keptRefs, keptTexts);
            lawContext = [lawContext, precBlock].filter(Boolean).join("\n\n");
          }
        }

        // 신호 기록 — retrieved 는 주입 카드 [{id,score}] 경량 저장. route 는 아래
        // 참조문서 구성이 확정된 뒤 분기한다(규정/법령/통합).
        logRow.top_score = maxScore;
        logRow.below_threshold = belowThreshold;
        logRow.out_of_scope = outOfScope;
        logRow.intents = intents.length >= 2 ? intents : null;
        logRow.retrieved = [...sources, ...precedentSources].map((s) => ({
          id: s.id,
          score: s.score,
        }));
        logRow.retrieved_doc_ids = sources.filter((s) => s.id > 0).map((s) => s.id);
        logRow.law_refs = lawRefs;

        const regCount = sources.length - lawParts.length;
        const lawCount = lawParts.length;
        // 참조문서 구성 기반 분기 — 규정만/법령만/혼합 = regulation/law/unified.
        logRow.route = outOfScope
          ? "out_of_scope"
          : routeFromComposition(regCount, lawCount);
        console.log(
          `[chat] route=${logRow.route} maxScore=${maxScore.toFixed(3)} ` +
            `threshold=${env.RELEVANCE_THRESHOLD} injected=${sources.length}(규정 ${regCount}·법령 ${lawParts.length})` +
            ` 판례=${precedentSources.length} 후보=규정 ${hits.length}·법령 ${lawCand.hits.length}` +
            (intents.length >= 2 ? ` intents=[${intents.join(" | ")}]` : "") +
            (lawRefs.length > 0 ? ` laws=[${lawRefs.map((r) => r.name).join(", ")}]` : ""),
        );

        // 5) 참조문서 선발송 — 통합 개편으로 표시분(주입분+판례)이 스트리밍 전에
        //    확정되므로 delta 앞에 보낸다. 사용자가 답변 도중 '멈춤'을 눌러도 참조
        //    패널이 유실되지 않는다(docs/08 이슈 A 해소). 범위 밖이면 빈 배열.
        const displayedSources = outOfScope
          ? []
          : [...sources, ...precedentSources];
        send(controller, { type: "sources", data: displayedSources });

        // 6) 답변 스트리밍. (인용 검증용으로 본문을 누적)
        //    범위 밖이면 어떤 근거도 주지 않아, 시스템 프롬프트의 범위 밖 거절만 나오게 한다.
        let answerText = "";
        const answerDocs = outOfScope ? [] : retrievedDocs;
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

        // 비용 가드: 소비 토큰(입력+출력)을 일일 예산에 누적(fire-and-forget). 임계치
        // 교차 시 관리자 이메일 경고. 응답 스트림을 지연시키지 않도록 await 하지 않는다.
        void recordTokens(clientIp, (usage?.input ?? 0) + (usage?.output ?? 0));

        // 7) 인용 검증 — 답변에 등장한 「법」 제N조가 법제처에 실존하는지 교차 검증
        //    (환각 경고 배지 전용 — 참조 카드 결정과 분리). 시스템 프롬프트가 자료 밖
        //    인용을 금지하므로 위반 감지 = 환각 감지다. 통합 이후 모든 답변에 법령
        //    인용이 섞일 수 있어 범위 밖만 빼고 항상 실행한다 — 인용이 0건이면 API
        //    호출도 0회, 답변 스트리밍 완료 뒤라 체감 지연 없음. 검색 후보 전체 맵
        //    (lawCand.retrieved)을 재사용해 후보에 있던 인용은 재조회 없이 검증.
        let citationCheck: CitationCheck | null = null;
        if (!outOfScope) {
          try {
            // 원질의 + 의도별 검색이 회수한 조문 전체를 재사용 맵으로 — 어느 의도의
            // 후보든 인용되면 법제처 재조회 없이 검증된다.
            const retrievedLaws = mergeRetrievedLaws([
              lawCand.retrieved,
              ...intentPools.map((p) => p.law.retrieved),
            ]);
            citationCheck = await verifyCitations(answerText, retrievedLaws);
          } catch (err) {
            console.error("[chat] citation verify failed:", (err as Error).message);
          }
        }

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

        // 8) 인용 검증 결과(✓/✗/⚠)를 전송(UI 환각 경고 배지 전용 — 카드 아님).
        //    본문(body)은 이벤트에서 떼어 가볍게 보낸다.
        if (citationCheck && citationCheck.verdicts.length > 0) {
          send(controller, {
            type: "citations",
            data: citationCheck.verdicts.map(({ body: _body, ...v }) => v),
            hasHallucination: citationCheck.hasHallucination,
          });
          console.log(
            `[chat] citations verified=${citationCheck.verdicts.filter((v) => v.status === "verified").length}/${citationCheck.verdicts.length} ` +
              `hallucination=${citationCheck.hasHallucination}`,
          );
        }

        // 감사 로그 적재(성공 경로). 삽입 행 id 를 받아 피드백 상관용으로 meta
        // 이벤트에 실어 보낸다. 답변 스트리밍이 끝난 뒤라 이 await 는 체감 지연이 없다.
        logRow.ttft_ms = ttftMs;
        logRow.total_ms = Date.now() - tStart;
        const queryId = await logQuery(logRow);
        logged = true;
        if (queryId != null) send(controller, { type: "meta", queryId });

        send(controller, { type: "done" });
      } catch (err) {
        // 오류 원문은 서버 로그에만 남기고, 클라이언트에는 일반화된 문구만 보낸다
        // (docs/07 §11 Critical — DB·외부 API 오류 원문 비노출). 원인 추적용 name 은
        // 관리자 로그(query_log.error_code)에만 적재되고 응답 본문엔 나가지 않는다.
        logRow.error_code = (err as Error).name || "stream_error";
        console.error("[chat] stream failed:", err);
        send(controller, {
          type: "error",
          message: "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
        });
      } finally {
        // 에러 등으로 아직 적재 안 됐으면 fire-and-forget 로 남긴다(응답 지연 없음).
        if (!logged) {
          logRow.ttft_ms = ttftMs;
          logRow.total_ms = Date.now() - tStart;
          void logQuery(logRow);
        }
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
