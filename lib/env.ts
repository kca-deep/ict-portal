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

  // 관리자 페이지(/admin) 보호 계정. 로그인이 없어 이 아이디+비밀번호 + 서명
  // httpOnly 쿠키로 관리자 화면을 보호한다. 둘 중 하나라도 미설정이면 /admin 은
  // 항상 차단된다. 세션 서명 키는 여전히 ADMIN_PASSWORD 를 쓴다(비번을 바꾸면
  // 기존 세션 자동 무효화). ADMIN_USERNAME 은 로그인 시점 게이트에만 관여한다.
  ADMIN_USERNAME: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),

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
  // 회색지대 상한 — maxScore 가 [RELEVANCE_THRESHOLD, RELEVANCE_GRAY_UPPER) 이면
  // 규정 관련도가 애매하다고 보고 LLM 적합성 게이트로 규정/법령을 재판정한다.
  // 임계치를 근소하게 넘긴 노이즈 규정청크의 오라우팅 차단(예: 0.35 vs 0.33).
  RELEVANCE_GRAY_UPPER: z.coerce.number().min(0).max(1).default(0.45),

  CRAWLER_USER_AGENT: z.string().default("PIMS-Crawler/1.0"),
  CRAWLER_TIMEOUT_MS: z.coerce.number().default(10000),
}).superRefine((val, ctx) => {
  // 부팅 가드: 로컬 개발은 유연하게 두되, 프로덕션에선 핵심 키가 비어 있으면
  // 부팅을 실패시킨다. 런타임 첫 호출에서야 터지는 사고(원인 추적난)를 막는다.
  if (process.env.NODE_ENV !== "production") return;
  const required = [
    "OPENAI_API_KEY", // 임베딩
    "ANTHROPIC_API_KEY", // 답변 LLM
    "COHERE_API_KEY", // 재정렬
    "LAW_GO_KR_API_KEY", // 법제처 조회
    "ADMIN_USERNAME", // 관리자 페이지 보호(아이디)
    "ADMIN_PASSWORD", // 관리자 페이지 보호(비밀번호)
  ] as const;
  for (const key of required) {
    if (!val[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} 는 프로덕션에서 필수입니다.`,
      });
    }
  }
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
