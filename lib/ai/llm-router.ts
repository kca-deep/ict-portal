import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT } from "@/lib/ai/prompts";

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
export async function* ragChatStream(
  messages: ChatMessage[],
  retrievedDocs: RetrievedDoc[],
): AsyncGenerator<string> {
  if (messages.length === 0) return;

  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];

  const augmented: ChatMessage = {
    role: last.role,
    content:
      retrievedDocs.length > 0
        ? buildUserMessage({ query: last.content, retrievedDocs })
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
}
