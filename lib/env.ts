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

  // 의도 분해 게이트 전용 소형 모델 — 답변 LLM(LLM_MODEL, Sonnet 단독)과 분리.
  // 분류·분해 수준의 작업이라 Haiku 로 충분하고 지연·비용이 낮다.
  INTENT_MODEL: z.string().default("claude-haiku-4-5"),

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
  // 통합 리랭킹(규정+법령 단일 풀)의 관련도 문턱 (rerank relevanceScore, 0~1).
  // ① 통합 maxScore 미만 → 근거 없음(범위 게이트로) ② 주입 항목별 바닥(노이즈 차단)
  // ③ 판례 필터의 공통 기준.
  RELEVANCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.33),
  // 복합 질의 의도 분해 시, 의도별 상위 2건에 한해 적용하는 완화 문턱(B안).
  // "절차 개요"형 의도는 조문 하나하나가 절차의 파편이라 점수가 낮게 갈리므로
  // (실측 0.25~0.35), 의도별 대표 근거의 진입로를 열어 준다. 3위부터는 기본 문턱.
  RELEVANCE_INTENT_FLOOR: z.coerce.number().min(0).max(1).default(0.25),

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
