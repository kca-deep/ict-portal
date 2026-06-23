import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  COHERE_API_KEY: z.string().optional(),

  LAW_GO_KR_API_KEY: z.string().optional(),
  LAW_GO_KR_BASE_URL: z
    .string()
    .url()
    .default("https://www.law.go.kr/DRF/lawSearch.do"),

  // 답변 LLM provider 토글. 기본 anthropic(기존 동작). openai 로 바꾸면 OPENAI_MODEL 사용.
  // 두 키(OPENAI/ANTHROPIC)는 임베딩 때문에 어차피 상시 필요 — 토글은 "어느 쪽을 답변에 쓸지"만 고른다.
  LLM_PROVIDER: z.enum(["anthropic", "openai"]).default("anthropic"),
  LLM_MODEL: z.string().default("claude-sonnet-4-6"),
  // openai provider 전용. gpt-5 계열은 추론 모델 — max_completion_tokens + reasoning_effort 사용.
  OPENAI_MODEL: z.string().default("gpt-5-nano"),
  OPENAI_REASONING_EFFORT: z
    .enum(["minimal", "low", "medium", "high"])
    .default("minimal"),

  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(1024),
  RERANK_MODEL: z.string().default("rerank-v3.5"),

  RETRIEVAL_TOP_K: z.coerce.number().default(30),
  RERANK_TOP_K: z.coerce.number().default(8),
  // 관련도 분기 기준치 (rerank 최상위 relevanceScore, 0~1). 미만이면 법제처 폴백.
  RELEVANCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.15),

  CRAWLER_USER_AGENT: z.string().default("PIMS-Crawler/1.0"),
  CRAWLER_TIMEOUT_MS: z.coerce.number().default(10000),

  // 챗 입력 가드 (공개 오픈 대비 — 비용·악용 증폭 차단)
  MAX_TURNS: z.coerce.number().default(30),
  MAX_CONTENT_CHARS: z.coerce.number().default(8000),

  // ingest 관리자 시크릿 — 미설정 시 /api/ingest 는 항상 403(외부 노출 금지).
  INGEST_SECRET: z.string().optional(),

  // Turnstile 봇 게이트 (공개 오픈). 토글 "false" 강제 OFF / 키 부재 시 자동 OFF(기존 동작).
  TURNSTILE_ENABLED: z.string().optional(),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),

  // 레이트리밋(공개 오픈 골격). 기본 OFF. 임계는 후속 개선.
  RATE_LIMIT_ENABLED: z.string().optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(20),
  RATE_LIMIT_DAILY_CAP: z.coerce.number().default(2000),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
