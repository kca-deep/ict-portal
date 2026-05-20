import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { SYSTEM_PROMPT } from "@/lib/ai/prompts";

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
  lawContext?: string; // 법령 도구 (lib/law/) 호출 결과 (옵션)
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
