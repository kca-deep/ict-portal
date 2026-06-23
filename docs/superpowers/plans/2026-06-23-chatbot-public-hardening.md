# PIMS 챗봇 공개 하드닝 (Turnstile 골격 + ingest 잠금 + 입력/에러 가드) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 챗봇(`/api/chat`)을 "누구나 사용(로그인 없음)" 공개로 열되, Turnstile 봇 게이트는 **토글/키 부재 시 기존 방식으로 무영향 폴백되는 골격**으로 넣고, ingest 폐쇄(C3)·에러 일반화(I1)·입력 상한(I2)을 실제 적용한다.

**Architecture:** 모든 신규 보안 게이트는 **기본 OFF**다. `lib/env.ts`에 optional 키·토글을 추가하고, 게이트 함수는 비활성/키부재 시 조기 통과한다. 따라서 키를 넣지 않은 현 프로덕션은 동작이 100% 동일하다. Turnstile은 서버 `siteverify` + 클라이언트 invisible 위젯 골격까지, Supabase 레이트리밋은 카운터 테이블·RPC·no-op 스텁 골격까지(임계 튜닝은 후속 개선).

**Tech Stack:** Next.js 15 App Router · TypeScript · Cloudflare Turnstile(무료, invisible) · Supabase Postgres(레이트리밋 카운터) · zod 환경검증.

## Global Constraints

- **기존 챗봇 동작은 절대 깨지지 않는다.** 모든 신규 게이트는 토글/키 부재 시 조기 통과(early-return)한다. 각 태스크 검증에 "토글 OFF에서 기존 흐름 동일" 수동 확인을 포함한다.
- **테스트 프레임워크 없음(PoC).** 검증은 `pnpm typecheck` + `pnpm build` 통과 + 로컬 `pnpm dev` 수동 curl/브라우저 확인으로 한다. (TDD 단위 테스트 스텝 대신 "동작 검증 스텝"을 쓴다.)
- **한 변경 = 한 커밋.** 기능과 DB 스키마 변경을 묶지 않는다(CLAUDE.md PoC 정책). 레이트리밋 마이그레이션은 단독 커밋.
- **DB 마이그레이션은 신규 추가만**(기존 수정 금지). 파일명 prefix는 기존 규칙(`YYYYMMDDHHMMSS_`) 따른다.
- **금지**: `.env*`/`node_modules` 커밋, `--no-verify`, `git push --force`.
- **용어**: 공모 aggregator는 "공모지원사업"(이 계획과 무관하나 문서 수정 시 유지).
- zod 불린 토글은 `z.coerce.boolean()` 사용 금지(`"false"`→true 함정). 문자열 optional + `=== "true"` 비교로 처리.

---

### Task 1: I2 — 챗 입력 길이·턴수 상한

**Files:**
- Modify: `lib/env.ts` (MAX_TURNS, MAX_CONTENT_CHARS 추가)
- Modify: `app/api/chat/route.ts:136-148` (`isValidMessages` 강화)

**Interfaces:**
- Produces: `isValidMessages(value): value is ChatMessage[]` — 길이/턴수 초과 시 false 반환(시그니처 불변).

- [ ] **Step 1: env에 상한값 추가**

`lib/env.ts`의 `envSchema` 객체 안(크롤러 항목 아래)에 추가:

```ts
  // 챗 입력 가드 (공개 오픈 대비 — 비용·악용 증폭 차단)
  MAX_TURNS: z.coerce.number().default(30),
  MAX_CONTENT_CHARS: z.coerce.number().default(8000),
```

- [ ] **Step 2: `isValidMessages`에 상한 검사 추가**

`app/api/chat/route.ts` 상단 import에 `env`는 이미 있음. `isValidMessages`를 다음으로 교체:

```ts
function isValidMessages(value: unknown): value is ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.length > env.MAX_TURNS) return false;
  return value.every(
    (m) =>
      m &&
      typeof m === "object" &&
      (m as ChatMessage).role !== undefined &&
      ((m as ChatMessage).role === "user" ||
        (m as ChatMessage).role === "assistant") &&
      typeof (m as ChatMessage).content === "string" &&
      (m as ChatMessage).content.trim().length > 0 &&
      (m as ChatMessage).content.length <= env.MAX_CONTENT_CHARS,
  );
}
```

- [ ] **Step 3: typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS (에러 0)

- [ ] **Step 4: 동작 검증(수동)**

`pnpm dev` 후 정상 질문 1건 전송 → 기존처럼 답변 스트리밍되는지 확인. 그리고:

Run:
```bash
curl -s -X POST http://localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"$(python3 -c 'print("가"*9000)')\"}]}" -o /dev/null -w '%{http_code}\n'
```
Expected: `400` (8000자 초과 거부). 정상 길이 질문은 200/스트림.

- [ ] **Step 5: Commit**

```bash
git add lib/env.ts app/api/chat/route.ts
git commit -m "feat(chat): 입력 길이·대화 턴수 상한 추가 (I2)"
```

---

### Task 2: I1 — 에러 일반화(내부 메시지 비노출)

**Files:**
- Modify: `app/api/chat/route.ts:326-328` (stream catch 블록)

**Interfaces:**
- Produces: stream `error` 이벤트의 `message`는 항상 일반화 문자열. 실제 에러는 서버 로그에만.

- [ ] **Step 1: catch 블록 교체**

`app/api/chat/route.ts`의 `ReadableStream` start 내부 `catch (err)`를 다음으로 교체:

```ts
      } catch (err) {
        // 내부 오류 메시지(DB 디테일·SDK 에러 등)는 클라이언트에 노출하지 않는다.
        // 실제 원인은 서버 로그로만 남기고, 사용자에겐 일반화 메시지를 전송한다.
        console.error("[chat] stream failed:", (err as Error).message);
        send(controller, {
          type: "error",
          message: "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
        });
      } finally {
        controller.close();
      }
```

- [ ] **Step 2: typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS

- [ ] **Step 3: 동작 검증(수동)**

`.env.local`에서 `ANTHROPIC_API_KEY`를 잠시 잘못된 값으로 바꾸고 `pnpm dev` → 질문 전송 → 브라우저에 **"일시적인 오류가 발생했습니다…"** 만 표시되고 SDK/내부 문자열이 안 보이는지 확인. 서버 콘솔엔 `[chat] stream failed:` 원문이 찍히는지 확인. 키 원복.

- [ ] **Step 4: Commit**

```bash
git add app/api/chat/route.ts
git commit -m "fix(chat): 스트림 오류 메시지 일반화 — 내부정보 비노출 (I1)"
```

---

### Task 3: C3 — `/api/ingest` 잠금(시크릿 헤더, 미설정 시 완전 차단)

**Files:**
- Modify: `lib/env.ts` (INGEST_SECRET 추가)
- Modify: `app/api/ingest/route.ts:24` (POST 앞단 인증 추가)

**Interfaces:**
- Consumes: `env.INGEST_SECRET`(optional). 미설정이면 엔드포인트는 항상 403(외부 노출 금지 기본값). 설정 시 `x-ingest-secret` 헤더 일치 요구.

- [ ] **Step 1: env에 시크릿 추가**

`lib/env.ts` `envSchema`에 추가:

```ts
  // ingest 관리자 시크릿 — 미설정 시 /api/ingest 는 항상 403(외부 노출 금지).
  INGEST_SECRET: z.string().optional(),
```

- [ ] **Step 2: ingest 핸들러에 게이트 추가**

`app/api/ingest/route.ts` 상단 import에 env 추가:

```ts
import { env } from "@/lib/env";
```

`export async function POST(req: NextRequest) {` 바로 다음 줄(try 이전)에 삽입:

```ts
  // C3: ingest 는 관리자 전용. 시크릿 미설정이면 완전 차단(docs/07 §4.4 "외부 노출 금지").
  if (!env.INGEST_SECRET) {
    return Response.json({ error: "ingest disabled" }, { status: 403 });
  }
  if (req.headers.get("x-ingest-secret") !== env.INGEST_SECRET) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
```

- [ ] **Step 3: typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS

- [ ] **Step 4: 동작 검증(수동)**

`INGEST_SECRET` 미설정 상태로 `pnpm dev`:
```bash
curl -s -X POST http://localhost:3000/api/ingest -H 'Content-Type: application/json' -d '{"documents":[]}' -w '\n%{http_code}\n'
```
Expected: `403 {"error":"ingest disabled"}`

`.env.local`에 `INGEST_SECRET=test123` 설정 후 재기동:
```bash
curl -s -X POST http://localhost:3000/api/ingest -H 'Content-Type: application/json' -H 'x-ingest-secret: test123' -d '{"documents":[]}' -w '\n%{http_code}\n'
```
Expected: `200 {"inserted":0}`. 헤더 없으면 401.

> 운영 적재 스크립트는 이제 `x-ingest-secret` 헤더를 보내야 한다(Task 6 문서에 명시).

- [ ] **Step 5: Commit**

```bash
git add lib/env.ts app/api/ingest/route.ts
git commit -m "feat(ingest): 관리자 시크릿 게이트 — 미설정 시 차단 (C3)"
```

---

### Task 4: Turnstile 봇 게이트 골격(토글/키 부재 시 기존 동작)

**Files:**
- Modify: `lib/env.ts` (Turnstile 키·토글 3개 추가)
- Create: `lib/security/turnstile.ts` (서버 검증 + enabled 판정)
- Modify: `app/api/chat/route.ts` (POST 앞단 토큰 검증, body 타입에 token 추가)
- Create: `components/turnstile-gate.tsx` (클라이언트 invisible 위젯 훅)
- Modify: `app/page.tsx` (전송 시 토큰 확보 후 body에 포함)

**Interfaces:**
- Produces:
  - `turnstileEnabled(): boolean` — 서버 게이트 활성 여부.
  - `verifyTurnstile(token: string | undefined, ip?: string): Promise<boolean>` — 비활성이면 항상 true.
  - `useTurnstileToken(): { ready: boolean; getToken: () => Promise<string | null>; Widget: () => JSX.Element | null }` — 클라 훅. site key 부재 시 `getToken`은 `null` 반환, `Widget`은 `null` 렌더.
- Consumes: `ChatRequest`에 optional `turnstileToken?: string` 추가.

- [ ] **Step 1: env에 Turnstile 항목 추가**

`lib/env.ts` `envSchema`에 추가:

```ts
  // Turnstile 봇 게이트 (공개 오픈). 토글 "false" 강제 OFF / 키 부재 시 자동 OFF(기존 동작).
  TURNSTILE_ENABLED: z.string().optional(),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
```

- [ ] **Step 2: 서버 검증 모듈 작성**

Create `lib/security/turnstile.ts`:

```ts
import { env } from "@/lib/env";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Turnstile 게이트 활성 판정(단일 진실원).
 * - TURNSTILE_ENABLED 가 "false" 면 강제 OFF.
 * - site/secret 키 둘 다 있어야 ON. 하나라도 없으면 기존 방식(게이트 없음).
 */
export function turnstileEnabled(): boolean {
  if (env.TURNSTILE_ENABLED === "false") return false;
  return Boolean(
    env.NEXT_PUBLIC_TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY,
  );
}

/**
 * 토큰을 Cloudflare 로 검증. 게이트 비활성이면 항상 통과(true).
 * 활성인데 토큰 없거나 검증 실패면 false(fail-closed).
 */
export async function verifyTurnstile(
  token: string | undefined,
  ip?: string,
): Promise<boolean> {
  if (!turnstileEnabled()) return true;
  if (!token) return false;

  const form = new URLSearchParams();
  form.set("secret", env.TURNSTILE_SECRET_KEY!);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error("[turnstile] verify failed:", (err as Error).message);
    return false; // 활성 상태에서 검증 불가면 차단
  }
}
```

- [ ] **Step 3: 챗 라우트에 게이트 추가**

`app/api/chat/route.ts` import에 추가:

```ts
import { verifyTurnstile } from "@/lib/security/turnstile";
```

`ChatRequest` 타입을 교체:

```ts
type ChatRequest = {
  messages: ChatMessage[];
  turnstileToken?: string;
};
```

`isValidMessages(body.messages)` 검사 블록 **다음**, `const lastUser = ...` **이전**에 삽입:

```ts
  // Turnstile 게이트(활성 시). 비활성/키부재면 verifyTurnstile 이 즉시 true.
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (!(await verifyTurnstile(body.turnstileToken, clientIp))) {
    return new Response("bot verification failed", { status: 403 });
  }
```

- [ ] **Step 4: 클라이언트 위젯 훅 작성**

Create `components/turnstile-gate.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/api.js?render=explicit";

// Cloudflare 가 주입하는 전역. 타입 최소 선언.
type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      size?: "invisible" | "normal" | "flexible";
      callback?: (token: string) => void;
      "error-callback"?: () => void;
    },
  ) => string;
  execute: (id: string) => void;
  reset: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/**
 * Invisible Turnstile 훅(골격).
 * - site key 부재 시: Widget=null, getToken()→null. 호출부는 토큰 없이 기존대로 전송.
 * - site key 존재 시: 보이지 않는 위젯을 렌더하고, getToken()이 execute→callback 토큰을 해결.
 *   토큰은 1회용이므로 매 전송 시 reset 후 새로 발급.
 */
export function useTurnstileToken() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const resolverRef = useRef<((t: string | null) => void) | null>(null);
  const [ready, setReady] = useState(!SITE_KEY); // 키 없으면 처음부터 준비완료(무게이트)

  useEffect(() => {
    if (!SITE_KEY || !containerRef.current) return;

    function renderWidget() {
      if (!window.turnstile || !containerRef.current || widgetIdRef.current)
        return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: SITE_KEY!,
        size: "invisible",
        callback: (token: string) => resolverRef.current?.(token),
        "error-callback": () => resolverRef.current?.(null),
      });
      setReady(true);
    }

    if (window.turnstile) {
      renderWidget();
      return;
    }
    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.setAttribute("src", SCRIPT_SRC);
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", renderWidget);
    return () => script.removeEventListener("load", renderWidget);
  }, []);

  const getToken = useCallback((): Promise<string | null> => {
    if (!SITE_KEY) return Promise.resolve(null); // 무게이트
    const api = window.turnstile;
    const id = widgetIdRef.current;
    if (!api || !id) return Promise.resolve(null);
    return new Promise((resolve) => {
      resolverRef.current = (t) => {
        resolverRef.current = null;
        api.reset(id); // 다음 전송용으로 초기화
        resolve(t);
      };
      api.execute(id);
    });
  }, []);

  const Widget = useCallback(
    () => (SITE_KEY ? <div ref={containerRef} className="hidden" /> : null),
    [],
  );

  return { ready, getToken, Widget };
}
```

- [ ] **Step 5: page.tsx 에서 토큰 확보 후 전송**

`app/page.tsx` import에 추가:

```ts
import { useTurnstileToken } from "@/components/turnstile-gate";
```

`Home` 컴포넌트 본문 상단(다른 훅들 옆)에 추가:

```ts
  const { getToken, Widget } = useTurnstileToken();
```

`send()` 안에서 `historyForApi` 구성 직후, `fetch` 호출 전에 토큰 확보:

```ts
    const turnstileToken = (await getToken()) ?? undefined;
```

`fetch` body 를 교체:

```ts
        body: JSON.stringify({ messages: historyForApi, turnstileToken }),
```

`return ( ... )` 의 최상위 `<main>` 안 끝부분(`{activeSource && ...}` 옆)에 위젯 마운트:

```tsx
      <Widget />
```

- [ ] **Step 6: typecheck + build (토글 OFF/키 부재 상태)**

Run: `pnpm typecheck && pnpm build`
Expected: PASS. (NEXT_PUBLIC_TURNSTILE_SITE_KEY 미설정이므로 위젯 미렌더 분기)

- [ ] **Step 7: 동작 검증(수동) — 키 부재 = 기존 동작**

키 미설정 `pnpm dev` → 질문 전송 → **기존과 동일하게** 답변 스트리밍(게이트 없음, 위젯 안 보임) 확인.

- [ ] **Step 8: 동작 검증(수동, 선택) — 키 설정 시 게이트 작동**

Cloudflare 무료 계정에서 Turnstile site/secret key 발급(Invisible 위젯) 후 `.env.local`에:
```
NEXT_PUBLIC_TURNSTILE_SITE_KEY=0x...
TURNSTILE_SECRET_KEY=0x...
```
재기동 → 질문 전송 시 백그라운드 검증 통과 후 정상 답변. 서버에서 토큰 없이 직접 curl 하면 403:
```bash
curl -s -X POST http://localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"안녕"}]}' -o /dev/null -w '%{http_code}\n'
```
Expected: `403`. (브라우저 경유는 토큰 포함되어 정상)

- [ ] **Step 9: Commit**

```bash
git add lib/env.ts lib/security/turnstile.ts app/api/chat/route.ts components/turnstile-gate.tsx app/page.tsx
git commit -m "feat(chat): Turnstile 봇 게이트 골격 — 토글/키부재 시 기존 동작 (C1 대체)"
```

---

### Task 5a: 레이트리밋 카운터 스키마(단독 커밋)

**Files:**
- Create: `supabase/migrations/<NEW_TS>_rate_limit_counter.sql`

> DB 스키마 변경은 단독 커밋(CLAUDE.md). 파일명 timestamp 는 기존 마지막 마이그레이션보다 뒤가 되도록 생성.

**Interfaces:**
- Produces: 테이블 `rate_limit_counter(bucket pk, count, expires_at)` · 함수 `increment_rate_limit(p_bucket text, p_expires timestamptz) returns int`(원자적 증가 후 현재값 반환).

- [ ] **Step 1: 마이그레이션 파일 생성**

새 timestamp 확인:
```bash
ls supabase/migrations | tail -3
```
그보다 뒤 timestamp로 `supabase/migrations/<NEW_TS>_rate_limit_counter.sql` 생성:

```sql
-- 레이트리밋/일일 비용캡 카운터 (공개 오픈 골격). 임계·정리는 후속 개선.
create table if not exists rate_limit_counter (
  bucket text primary key,          -- 예: "ip:1.2.3.4:202606231012" | "global:20260623"
  count integer not null default 0,
  expires_at timestamptz not null
);

alter table rate_limit_counter enable row level security;
-- 명시 정책 없음 → service_role 만 접근(요청 경로는 admin 클라이언트 사용).

-- 버킷 카운터를 원자적으로 +1 하고 현재값을 반환. 없으면 1로 생성.
create or replace function increment_rate_limit(
  p_bucket text,
  p_expires timestamptz
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into rate_limit_counter (bucket, count, expires_at)
    values (p_bucket, 1, p_expires)
  on conflict (bucket)
    do update set count = rate_limit_counter.count + 1
  returning count into v_count;
  return v_count;
end;
$$;
```

- [ ] **Step 2: 마이그레이션 적용 + 빌드**

Run: `pnpm db:push && pnpm build`
Expected: 마이그레이션 적용 성공, 빌드 PASS.

- [ ] **Step 3: Commit (스키마 단독)**

```bash
git add supabase/migrations/<NEW_TS>_rate_limit_counter.sql
git commit -m "feat(db): 레이트리밋 카운터 테이블·RPC 추가"
```

---

### Task 5b: 레이트리밋 골격 모듈 + 라우트 연결(기본 OFF)

**Files:**
- Modify: `lib/env.ts` (RATE_LIMIT_ENABLED, RATE_LIMIT_PER_MIN, RATE_LIMIT_DAILY_CAP)
- Create: `lib/security/ratelimit.ts`
- Modify: `app/api/chat/route.ts` (Turnstile 게이트 다음에 레이트리밋 체크)

**Interfaces:**
- Consumes: Task 5a 의 `increment_rate_limit` RPC, Task 4 의 게이트 위치.
- Produces: `checkRateLimit(ip: string | undefined): Promise<{ ok: boolean }>` — 비활성이면 `{ ok: true }`.

- [ ] **Step 1: env에 레이트리밋 항목 추가**

`lib/env.ts` `envSchema`에 추가:

```ts
  // 레이트리밋(공개 오픈 골격). 기본 OFF. 임계는 후속 개선.
  RATE_LIMIT_ENABLED: z.string().optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(20),
  RATE_LIMIT_DAILY_CAP: z.coerce.number().default(2000),
```

- [ ] **Step 2: 레이트리밋 모듈 작성(골격)**

Create `lib/security/ratelimit.ts`:

```ts
import { getSupabaseAdmin } from "@/lib/db/supabase";
import { env } from "@/lib/env";

export function rateLimitEnabled(): boolean {
  return env.RATE_LIMIT_ENABLED === "true";
}

async function bump(bucket: string, expires: Date): Promise<number> {
  const { data, error } = await getSupabaseAdmin().rpc("increment_rate_limit", {
    p_bucket: bucket,
    p_expires: expires.toISOString(),
  });
  if (error) throw new Error(`increment_rate_limit failed: ${error.message}`);
  return (data as number) ?? 0;
}

/**
 * IP 분당 호출 + 전역 일일 호출 캡 체크(골격).
 * 비활성이면 즉시 통과. 카운터 장애 시 fail-open(가용성 우선) — 후속 개선에서 정책 재검토.
 */
export async function checkRateLimit(
  ip: string | undefined,
): Promise<{ ok: boolean }> {
  if (!rateLimitEnabled()) return { ok: true };
  try {
    const now = new Date();
    const minute = now.toISOString().slice(0, 16).replace(/[-:T]/g, ""); // YYYYMMDDHHMM
    const day = now.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
    const ipKey = ip ?? "unknown";

    const perMin = await bump(
      `ip:${ipKey}:${minute}`,
      new Date(now.getTime() + 120_000),
    );
    if (perMin > env.RATE_LIMIT_PER_MIN) return { ok: false };

    const daily = await bump(
      `global:${day}`,
      new Date(now.getTime() + 86_400_000),
    );
    if (daily > env.RATE_LIMIT_DAILY_CAP) return { ok: false };

    return { ok: true };
  } catch (err) {
    console.error("[ratelimit] check failed, allowing:", (err as Error).message);
    return { ok: true };
  }
}
```

- [ ] **Step 3: 라우트에 연결**

`app/api/chat/route.ts` import에 추가:

```ts
import { checkRateLimit } from "@/lib/security/ratelimit";
```

Task 4 에서 넣은 Turnstile 게이트 **다음 줄**에 삽입:

```ts
  // 레이트리밋(활성 시). 비활성이면 checkRateLimit 이 즉시 통과.
  if (!(await checkRateLimit(clientIp)).ok) {
    return new Response("rate limit exceeded", { status: 429 });
  }
```

- [ ] **Step 4: typecheck + build (기본 OFF)**

Run: `pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: 동작 검증(수동)**

`RATE_LIMIT_ENABLED` 미설정으로 `pnpm dev` → 질문 여러 번 전송해도 제한 없이 기존대로 동작(무게이트) 확인. (선택) `.env.local`에 `RATE_LIMIT_ENABLED=true`, `RATE_LIMIT_PER_MIN=2` 후 재기동 → 1분 내 3번째 호출에서 429 확인.

- [ ] **Step 6: Commit**

```bash
git add lib/env.ts lib/security/ratelimit.ts app/api/chat/route.ts
git commit -m "feat(chat): 레이트리밋·일일캡 골격 연결 (기본 OFF, C2)"
```

---

### Task 6: 문서·환경예시 정합

**Files:**
- Modify: `CLAUDE.md` (이용 대상·하드닝 문구)
- Modify: `docs/00-overview.md`, `docs/07-security-ops.md` (공개 정책 반영)
- Create/Modify: `.env.example` (신규 키 문서화)

> `.env.example`은 현재 워킹트리에서 `D`(삭제) 상태(git status). 신규 키 포함해 재생성.

**Interfaces:** 없음(문서).

- [ ] **Step 1: `.env.example` 재생성**

기존 키(Task 시작 시 `git show HEAD:.env.example`로 확인) 뒤에 보안 섹션 추가:

```bash
# === 보안/공개 오픈 ===
# Turnstile 봇 게이트. 둘 다 채우면 활성. "false" 면 강제 OFF. 미설정이면 게이트 없음(기존 동작).
TURNSTILE_ENABLED=
NEXT_PUBLIC_TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
# 챗 입력 가드
MAX_TURNS=30
MAX_CONTENT_CHARS=8000
# 레이트리밋(기본 OFF). "true" 로 활성.
RATE_LIMIT_ENABLED=
RATE_LIMIT_PER_MIN=20
RATE_LIMIT_DAILY_CAP=2000
# ingest 관리자 시크릿(미설정 시 /api/ingest 차단). 적재 스크립트는 x-ingest-secret 헤더로 전송.
INGEST_SECRET=
```

- [ ] **Step 2: `CLAUDE.md` 이용대상 문구 갱신**

"이용 대상은 **ICT기금 외부 기관 담당자**(로그인 필수, 공개 가입 차단, 초대·승인 기반 계정)" 부분을 실제 결정에 맞게 수정:

> 이용 대상은 **불특정 공개 이용자**(로그인 없음). 봇·악용은 Turnstile 봇 게이트(토글/키 기반)와 IP 레이트리밋·일일 호출 캡으로 통제. 두 게이트 모두 키/토글 부재 시 비활성(기존 동작 유지).

- [ ] **Step 3: `docs/07-security-ops.md` 하드닝 항목 반영**

§4.3(레이트리밋), §4.4(ingest), §5(에러 일반화) 항목에 "구현됨(골격/적용)" 상태와 토글·env 키를 한 줄씩 추가. `query_log`(I3)·RLS(I4)는 **미구현/후속**으로 명시(이 계획 범위 밖).

- [ ] **Step 4: build (문서만이라 영향 없음 확인)**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/00-overview.md docs/07-security-ops.md .env.example
git commit -m "docs: 공개 오픈 정책·보안 env 키 문서화"
```

---

## 범위 밖(후속 — 이 계획에 포함하지 않음)

- **I3 query_log 적재** — 감사로그/사용량 회계. 익명 공개라 user_id 대신 IP/세션 기반. **단독 DB PR**로 별도 진행.
- **I4 RLS 준수 요청경로** — 요청 경로의 service_role → anon/JWT 클라이언트 전환. 익명 공개에선 우선순위 낮음.
- **레이트리밋 임계 튜닝·만료 row 정리(cron)·킬스위치 UI** — "Supabase 부분 개선" 단계에서.
- **M1 X-Model 헤더 제거 / M4 보안 헤더(CSP 등)** — 별도 폴리시 작업.
- **법률 자문 오인 방지 면책 고지 UI** — 공개 대상 확대 시 법무 검토 후.

## Self-Review

- **스펙 커버리지**: 사용자 명시 항목 — Turnstile 골격(토글/키부재 폴백)=Task4 ✅, Supabase 레이트리밋 골격=Task5a/5b ✅, ingest=Task3 ✅, I1=Task2 ✅, I2=Task1 ✅, "기존 챗봇 동작 유지"=모든 게이트 기본 OFF + 각 태스크 수동 회귀 확인 ✅.
- **Placeholder 스캔**: 모든 코드 스텝에 실제 코드 포함. `<NEW_TS>`는 의도적 동적값(생성 시 결정)이며 생성 절차를 Step에 명시.
- **타입 일관성**: `turnstileEnabled`/`verifyTurnstile`/`checkRateLimit`/`useTurnstileToken` 시그니처가 정의·소비처에서 일치. `ChatRequest.turnstileToken?` 추가가 클라 body와 정합.
