import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import {
  CHAT_SYSTEM_PROMPT,
  RELEVANCE_GATE_PROMPT,
  SCOPE_GATE_PROMPT,
  SYSTEM_PROMPT,
} from "@/lib/ai/prompts";

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

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

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
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
    const res = await anthropic.messages.create({
      model: env.LLM_MODEL,
      max_tokens: 8,
      system: [{ type: "text", text: RELEVANCE_GATE_PROMPT }],
      messages: [
        {
          role: "user",
          content: `질문: ${query}\n\n<내부규정>\n${context}\n</내부규정>\n\n위 내부 규정만으로 질문의 핵심에 답할 수 있으면 YES, 핵심 근거가 없으면 NO. 한 단어만.`,
        },
      ],
    });
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
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
    const res = await anthropic.messages.create({
      model: env.LLM_MODEL,
      max_tokens: 8,
      system: [{ type: "text", text: SCOPE_GATE_PROMPT }],
      messages: [
        {
          role: "user",
          content: `질문: ${query}\n\n위 질문이 이 서비스(ICT기금 규정·법령·행정) 안내 범위에 속하면 YES, 무관하면 NO. 한 단어만.`,
        },
      ],
    });
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
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

export async function* answerStream(ctx: ChatContext): AsyncGenerator<string> {
  // SDK 0.32.1 타입이 thinking/cache_control 누락 — 런타임은 정상. TODO: SDK 업그레이드 후 cast 제거.
  const stream = anthropic.messages.stream({
    model: env.LLM_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: buildUserMessage(ctx) }],
  } as unknown as Anthropic.MessageStreamParams);

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}

export async function* chatStream(
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const stream = anthropic.messages.stream({
    model: env.LLM_MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: CHAT_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}

/**
 * RAG 챗 스트림: 멀티턴 히스토리를 유지하면서, 마지막 user 메시지에만
 * 검색된 청크를 <context> 블록으로 감싸 주입한다.
 */
export type TokenUsage = { input: number; output: number };

export async function* ragChatStream(
  messages: ChatMessage[],
  retrievedDocs: RetrievedDoc[],
  lawContext?: string,
): AsyncGenerator<string, TokenUsage | undefined> {
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

  const stream = anthropic.messages.stream({
    model: env.LLM_MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: finalMessages.map((m) => ({ role: m.role, content: m.content })),
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }

  // 스트림 소비 후 최종 메시지에서 토큰 사용량을 회수(감사 로그용). 실패해도
  // 답변엔 영향 없도록 undefined 로 폴백한다.
  try {
    const u = await stream.finalMessage().then((m) => m.usage);
    // 시스템 프롬프트가 prompt caching 되어 input_tokens 엔 비캐시분만 잡힌다.
    // 실제 처리한 입력 총량을 위해 캐시 생성/읽기 토큰을 합산한다.
    return {
      input:
        u.input_tokens +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0),
      output: u.output_tokens,
    };
  } catch (err) {
    console.error(
      "[chat] finalMessage usage unavailable:",
      (err as Error).message,
    );
    return undefined;
  }
}
