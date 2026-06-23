import OpenAI from "openai";
import { env } from "@/lib/env";
import type { ChatProvider, StreamOpts, CompleteOpts } from "./types";

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    if (!env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY 누락 (.env.local 확인)");
    }
    _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _client;
}

// gpt-5 계열은 추론 모델 — max_tokens 가 아니라 max_completion_tokens 를 쓰고
// reasoning_effort 를 받는다. temperature 커스텀은 미지원이라 보내지 않는다.
// (reasoning_effort 는 gpt-5/o-series 전용 파라미터다.)
export const openaiProvider: ChatProvider = {
  async *stream({ system, messages, maxTokens }: StreamOpts) {
    const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    const stream = await client().chat.completions.create({
      model: env.OPENAI_MODEL,
      max_completion_tokens: maxTokens,
      reasoning_effort: env.OPENAI_REASONING_EFFORT,
      stream: true,
      messages: chatMessages,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  },

  async complete({ system, user, maxTokens }: CompleteOpts) {
    const res = await client().chat.completions.create({
      model: env.OPENAI_MODEL,
      // 추론 모델은 한도를 추론 토큰에 먼저 쓴다 — 게이트 호출이 너무 작은 한도면
      // 본문(YES/NO)이 비어 나온다. 충분한 한도는 llm-router(GATE_MAX_TOKENS)에서 보장.
      max_completion_tokens: maxTokens,
      reasoning_effort: env.OPENAI_REASONING_EFFORT,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return res.choices[0]?.message?.content ?? "";
  },
};
