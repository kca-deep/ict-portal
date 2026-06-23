import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import type { ChatProvider, StreamOpts, CompleteOpts } from "./types";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY 누락 (.env.local 확인)");
    }
    _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return _client;
}

export const anthropicProvider: ChatProvider = {
  async *stream({ system, messages, maxTokens }: StreamOpts) {
    const stream = client().messages.stream({
      model: env.LLM_MODEL,
      max_tokens: maxTokens,
      // 시스템 프롬프트는 멀티턴 내내 동일 → ephemeral 캐시로 입력 비용 절감.
      system: [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
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
  },

  async complete({ system, user, maxTokens }: CompleteOpts) {
    const res = await client().messages.create({
      model: env.LLM_MODEL,
      max_tokens: maxTokens,
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content: user }],
    });
    return res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
  },
};
