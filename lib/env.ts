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

  LLM_MODEL: z.string().default("claude-sonnet-4-6"),

  // ingest 관리자 시크릿 — 미설정 시 /api/ingest 는 항상 403(외부 노출 금지).
  INGEST_SECRET: z.string().optional(),

  // 입력 캡 — 한 요청의 대화 턴 수·메시지 글자 수 상한(비용/남용 방지).
  MAX_TURNS: z.coerce.number().default(30),
  MAX_CONTENT_CHARS: z.coerce.number().default(8000),

  // IP 레이트리밋 — RATE_LIMIT_ENABLED="true" 일 때만 활성(기본 비활성, 기존 동작 유지).
  RATE_LIMIT_ENABLED: z.string().optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(20),
  RATE_LIMIT_DAILY_CAP: z.coerce.number().default(2000),

  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(1024),
  RERANK_MODEL: z.string().default("rerank-v3.5"),

  RETRIEVAL_TOP_K: z.coerce.number().default(30),
  RERANK_TOP_K: z.coerce.number().default(8),
  // 관련도 분기 기준치 (rerank 최상위 relevanceScore, 0~1). 미만이면 법제처 폴백.
  RELEVANCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.33),

  CRAWLER_USER_AGENT: z.string().default("PIMS-Crawler/1.0"),
  CRAWLER_TIMEOUT_MS: z.coerce.number().default(10000),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
