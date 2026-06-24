import { env } from "@/lib/env";
import {
  RELEVANCE_GATE_PROMPT,
  SCOPE_GATE_PROMPT,
  SYSTEM_PROMPT,
} from "@/lib/ai/prompts";
import type { ChatMessage, ChatProvider } from "@/lib/ai/providers/types";
import { anthropicProvider } from "@/lib/ai/providers/anthropic";
import { openaiProvider } from "@/lib/ai/providers/openai";

// route·UI 가 기존대로 import 하도록 재노출 (provider 경계로 옮겨도 시그니처 불변).
export type { ChatMessage } from "@/lib/ai/providers/types";

// 게이트 응답 한도. 추론 모델(gpt-5)은 한도를 추론에 먼저 쓰므로 YES/NO 가 비지 않도록
// 여유를 둔다. max_completion_tokens/max_tokens 모두 상한일 뿐이라 Anthropic 비용엔 영향 없음.
const GATE_MAX_TOKENS = 256;
// 답변 한도. gpt-5 계열은 max_completion_tokens 가 '추론+출력' 합산이라, reasoning_effort 를
// 올리면 추론이 한도를 잠식해 출력(답변)이 짧아진다. 추론+출력 헤드룸을 넉넉히 둔다.
// (상한일 뿐 — 프롬프트가 분량을 통제하므로 Anthropic·OpenAI 모두 무해.)
const ANSWER_MAX_TOKENS = 16000;

// env.LLM_PROVIDER 로 답변 LLM 구현체 하나를 고정 선택(정적 토글).
function getProvider(): ChatProvider {
  return env.LLM_PROVIDER === "openai" ? openaiProvider : anthropicProvider;
}

export type RetrievedDoc = {
  title?: string | null;
  source_ref?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
};

export type ChatContext = {
  query: string;
  retrievedDocs: RetrievedDoc[];
  lawContext?: string;
};

function buildContextBlock(ctx: ChatContext): string {
  const parts: string[] = [];
  if (ctx.retrievedDocs.length > 0) {
    parts.push("## [내부 규정·지침·해석사례]");
    ctx.retrievedDocs.forEach((d, i) => {
      const ref = d.source_ref ? ` (출처: ${d.source_ref})` : "";
      parts.push(`### 자료 ${i + 1}${ref} ${d.title ?? ""}\n${d.content}`);
    });
  }
  if (ctx.lawContext) {
    parts.push("## [법령·판례 (법제처)]");
    parts.push(ctx.lawContext);
  }
  return parts.join("\n\n");
}

function buildUserMessage(ctx: ChatContext): string {
  return `<context>\n${buildContextBlock(ctx)}\n</context>\n\n질문: ${ctx.query}`;
}

/**
 * 적합성 게이트: 검색된 내부 규정만으로 질문에 답할 핵심 근거가 있는지 LLM이 YES/NO로 판정.
 * "관련도 점수는 기준치 이상이지만 실제로는 규정에 답이 없는" 회색지대를 잡아
 * 법제처 폴백 여부를 결정한다. 실패 시 충분(true)으로 폴백해 답변을 막지 않는다.
 */
export async function isRegulationSufficient(
  query: string,
  retrievedDocs: RetrievedDoc[],
): Promise<boolean> {
  if (retrievedDocs.length === 0) return false;
  try {
    const context = retrievedDocs
      .map((d, i) => `[자료 ${i + 1}] ${d.title ?? ""}\n${d.content}`)
      .join("\n\n");
    const text = (
      await getProvider().complete({
        system: RELEVANCE_GATE_PROMPT,
        user: `질문: ${query}\n\n<내부규정>\n${context}\n</내부규정>\n\n위 내부 규정만으로 질문의 핵심에 답할 수 있으면 YES, 핵심 근거가 없으면 NO. 한 단어만.`,
        maxTokens: GATE_MAX_TOKENS,
      })
    )
      .trim()
      .toUpperCase();
    return !text.startsWith("NO");
  } catch (err) {
    console.error(
      "[chat] relevance gate failed, treating as sufficient:",
      (err as Error).message,
    );
    return true;
  }
}

/**
 * 범위 게이트: 질문이 이 서비스(ICT기금 규정·법령·행정) 안내 범위인지 YES/NO 판정.
 * 규정 관련도가 낮은 질의(잡담 포함)에만 호출해, 범위 밖이면 법령·판례 검색과
 * 참조문서를 모두 생략하고 정중히 거절만 하도록 route 가 분기한다.
 * 실패 시 범위 내(true)로 폴백 — 게이트 장애로 정상 질문을 막지 않는다.
 */
export async function isInScope(query: string): Promise<boolean> {
  if (!query.trim()) return false;
  try {
    const text = (
      await getProvider().complete({
        system: SCOPE_GATE_PROMPT,
        user: `질문: ${query}\n\n위 질문이 이 서비스(ICT기금 규정·법령·행정) 안내 범위에 속하면 YES, 무관하면 NO. 한 단어만.`,
        maxTokens: GATE_MAX_TOKENS,
      })
    )
      .trim()
      .toUpperCase();
    return !text.startsWith("NO");
  } catch (err) {
    console.error(
      "[chat] scope gate failed, treating as in-scope:",
      (err as Error).message,
    );
    return true;
  }
}

/**
 * RAG 챗 스트림: 멀티턴 히스토리를 유지하면서, 마지막 user 메시지에만
 * 검색된 청크를 <context> 블록으로 감싸 주입한다.
 */
export async function* ragChatStream(
  messages: ChatMessage[],
  retrievedDocs: RetrievedDoc[],
  lawContext?: string,
): AsyncGenerator<string> {
  if (messages.length === 0) return;

  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];

  const hasContext = retrievedDocs.length > 0 || Boolean(lawContext);
  const augmented: ChatMessage = {
    role: last.role,
    content: hasContext
      ? buildUserMessage({ query: last.content, retrievedDocs, lawContext })
      : last.content,
  };

  const finalMessages = [...messages.slice(0, lastIdx), augmented];

  yield* getProvider().stream({
    system: SYSTEM_PROMPT,
    messages: finalMessages,
    maxTokens: ANSWER_MAX_TOKENS,
  });
}
