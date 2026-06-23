// 답변 LLM provider 공통 경계. llm-router 가 env.LLM_PROVIDER 로 구현체 하나를 고른다.
// provider 는 "시스템 프롬프트 + 메시지를 받아 텍스트를 흘리는/돌려주는" 역할만 진다.
// RAG augmentation·프롬프트 선택·YES/NO 파싱 등 도메인 로직은 llm-router 에 공유로 남는다.

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type StreamOpts = {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
};

export type CompleteOpts = {
  system: string;
  user: string;
  maxTokens: number;
};

export interface ChatProvider {
  // 답변 스트리밍: 텍스트 청크를 순차 yield.
  stream(opts: StreamOpts): AsyncGenerator<string>;
  // 단발 호출(게이트용): 응답 본문 전체를 문자열로.
  complete(opts: CompleteOpts): Promise<string>;
}
