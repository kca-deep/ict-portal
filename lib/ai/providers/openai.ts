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
      // 게이트(YES/NO 분류)는 추론이 불필요하다. 답변용 reasoning_effort(env)를 그대로
      // 쓰면 추론 토큰이 작은 한도를 모두 소진해 본문이 빈 채로 잘려 나온다(검증: low+64
      // → "" finish=length). 게이트는 항상 minimal 로 고정해 신뢰성을 답변 설정과 분리한다.
      max_completion_tokens: maxTokens,
      reasoning_effort: "minimal",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return res.choices[0]?.message?.content ?? "";
  },
};
