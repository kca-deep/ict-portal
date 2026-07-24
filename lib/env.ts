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

  // 공공데이터포털 한국천문연구원 특일 정보(getRestDeInfo) 디코딩 서비스키.
  // 관리자 대시보드의 "쉬는 날 사용" 지표(공휴일·대체·선거일 포함) 판정용. 선택 —
  // 미설정 시 주말만 쉬는 날로 폴백(공휴일 미반영).
  DATA_GO_KR_API_KEY: z.string().optional(),

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

  // ── 레이트리밋·비용 가드 (Upstash Redis) ──────────────────────────────────
  // 공개(no-login) 챗 엔드포인트의 핵심 방어선. 저장소는 Upstash Redis.
  // 프로덕션은 기본 활성(RATE_LIMIT_ENABLED="false" 로만 해제), 로컬은 opt-in("true").
  RATE_LIMIT_ENABLED: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(20), // IP 분당 요청(슬라이딩 윈도)
  RATE_LIMIT_IP_DAILY_CAP: z.coerce.number().default(500), // IP 일일 요청
  RATE_LIMIT_DAILY_CAP: z.coerce.number().default(2000), // 전역 일일 요청
  // 비용 가드 — 일일 토큰 예산(입력+출력). 초과 시 429.
  COST_IP_DAILY_TOKENS: z.coerce.number().default(200_000), // IP 일일 토큰
  COST_GLOBAL_DAILY_TOKENS: z.coerce.number().default(5_000_000), // 전역 일일 토큰
  // 예산 대비 이 비율을 넘으면 관리자 이메일 경고(하루 1회). 0~1.
  ALERT_COST_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),

  // ── 알림 (Resend 이메일) ──────────────────────────────────────────────────
  // 비용·남용 임계치 초과 경고. 키가 없으면 no-op(로컬 안전).
  RESEND_API_KEY: z.string().optional(),
  ALERT_EMAIL_FROM: z.string().optional(), // 인증된 발신 도메인 주소
  ALERT_EMAIL_TO: z.string().optional(), // 관리자 수신 주소

  // 관리자 세션 서명 키 — 미설정 시 ADMIN_PASSWORD 로 폴백(비번 변경=세션 무효화).
  // 상용에선 비번과 분리해 설정(비번을 바꿔도 세션 유지, 키 유출 대응 분리).
  ADMIN_SESSION_SECRET: z.string().optional(),

  // 관리자 표면 하드닝(미들웨어에서 소비 — process.env 직접 참조, 여기선 문서화·검증용).
  // ADMIN_ALLOWED_IPS: 쉼표 구분 IPv4/CIDR 허용목록. 프로덕션에서 미설정이면 관리자
  //   표면(/admin·/api/admin) 전체가 404(기본 거부). 기관 고정 IP(SSLVPN egress) 전제.
  // ADMIN_PATH_SECRET: 관리자 화면 시크릿 슬러그(URL-safe 문자만). 설정 시 /{slug}/* 로만
  //   접근 가능하고 /admin 직접 접근은 404 은닉. 미설정이면 기존 /admin 유지.
  ADMIN_ALLOWED_IPS: z.string().optional(),
  // 교차 출처 허용 목록(쉼표 구분, 미들웨어 소비). 미설정 = 순수 동일 출처(현행 그대로).
  // Vercel 기본 도메인 사용 시 예: https://<프로젝트>.vercel.app
  ALLOWED_ORIGINS: z.string().optional(),
  // BotID 집행 모드 — "off" 면 판정을 로그로만 남기고 차단 안 함(오탐 조사·비상 개방용).
  // 미설정(기본) = 차단(enforce). 라우트가 process.env 직접 참조, 여기선 문서화용.
  BOTID_ENFORCEMENT: z.enum(["on", "off"]).optional(),
  // 가장자리 슬래시는 미들웨어·페이지가 정규화하므로 허용(설정 실수 방어), 본체는 URL-safe 만.
  ADMIN_PATH_SECRET: z
    .string()
    .regex(/^\/?[A-Za-z0-9_-]+\/?$/, "ADMIN_PATH_SECRET 은 URL-safe 문자(영숫자·-·_)만 허용")
    .optional(),

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
    // 공개(no-login) 엔드포인트의 핵심 방어선 — 상용에선 저장소가 반드시 있어야
    // 레이트리밋·비용가드가 실효(없으면 프로덕션 fail-closed 로 챗이 막힘).
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
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

// .env 관례상 `KEY=`(빈 문자열)는 "미설정"을 뜻한다. zod `.optional()` 은 undefined
// 만 건너뛰고 빈 문자열은 존재값으로 취급하므로, 빈 URL·빈 coerce 숫자 하나가 스키마
// 전체 parse 를 던지고(→ env 를 import 하는 모든 라우트가 500) 만다. parse 전에 빈
// 문자열을 undefined 로 정규화해 이 부류의 부팅 사고를 차단한다(default·optional 정상 동작).
const normalizedEnv = Object.fromEntries(
  Object.entries(process.env).map(([k, v]) => [k, v === "" ? undefined : v]),
);

export const env = envSchema.parse(normalizedEnv);
export type Env = z.infer<typeof envSchema>;
