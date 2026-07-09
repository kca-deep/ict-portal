# 관리자 로그인 — id/pw 인증 + 시안 콘솔 테마

- 날짜: 2026-07-09
- 상태: 설계 승인 대기 → 구현 예정
- 범위: 관리자 로그인 화면(`/admin/login`)의 인증 방식 변경 + 시각 리스타일. **경량 유지**(신규 인프라 0).

## 배경 / 문제

현재 관리자 로그인(`app/admin/login/page.tsx`)은 **비밀번호 한 칸**만 받고, 서버(`app/api/admin/login/route.ts`)는 단일 `ADMIN_PASSWORD` 하나만 `timingSafeEqual`로 확인한다. 세션은 HMAC-SHA256 서명 httpOnly 쿠키(`lib/admin-auth.ts`)로 유지하고, `middleware.ts`가 `/admin/*` 게이트를 담당한다.

요구 두 가지:
1. **id/pw 인증** — 아이디+비밀번호 둘 다 확인하도록 로그인 방식 변경.
2. **시각 통일** — `app/admin/login/admin_advisor_console_proposal.html` 시안의 "시안/틸 콘솔 룩"을 **로그인 페이지에만** 적용.

## 결정된 방향 (brainstorming)

- 인증 범위: **관리자 콘솔만, 경량 유지.** 현행 HMAC 쿠키·미들웨어 구조를 그대로 두고 id/pw만 추가한다. Supabase Auth는 **도입하지 않는다**(참고 섹션으로만 문서화).
- 테마 범위: **로그인 페이지만** 시안 콘솔 룩. 대시보드(`app/admin/page.tsx`)와 전역 테마 토큰은 건드리지 않는다. → 결과적으로 로그인 화면과 대시보드의 액센트 색이 다르다(로그인=시안, 대시보드=잉크블루). 사용자 인지·승인 완료.

## 시안 팔레트 (proposal HTML `:root` 발췌)

| 토큰 | 값 | 용도 |
|---|---|---|
| paper | `#eef1f4` | 페이지 배경(쿨 그레이블루) |
| surface | `#ffffff` | 카드 표면 |
| input | `#f1f4f7` | 입력칸 배경 |
| border | `#dde3ea` | 경계선 |
| text / text-2 / text-muted / text-dim | `#0f1922` / `#53616e` / `#7d8b98` / `#a9b4bf` | 텍스트 4단계 |
| cyan / cyan-soft | `#0a94ab` / `#077f94` | 주 액센트(버튼·포커스·브랜드) |
| critical | `#d93a3a` | 오류 메시지 |
| shadow-md | `0 4px 14px -6px rgba(15,25,34,.14), 0 1px 3px rgba(15,25,34,.05)` | 카드 그림자 |
| sans | IBM Plex Sans KR | 본문(이미 전역 상속) |
| mono | JetBrains Mono → 시스템 모노 폴백 | 라벨·서브텍스트 |

배경 디테일: 페이지 전체에 52px 그리드 라인 오버레이 + 좌상단 시안 / 우하단 앰버 라디얼 그라디언트(시안 `body` / `body::before` 재현).

## 설계

### A. 로그인 페이지 리스타일 — `app/admin/login/page.tsx`

- 시안 팔레트를 **로그인 전용 스코프**로 한정한다. globals.css 전역 토큰으로 승격하지 않는다.
  - 방식: 로그인 루트에 래퍼 클래스(예: `.login-console`)를 두고, 그 하위에서만 유효한 CSS 변수·규칙으로 팔레트/그리드 배경/라디얼을 정의. 색은 Tailwind arbitrary 값 또는 스코프 CSS 변수로 표현. 전역 오염 없음.
- 레이아웃(시안 재현):
  - 페이지: `#eef1f4` 배경 + 그리드 오버레이 + 코너 라디얼, 세로·가로 중앙 정렬.
  - 카드: `surface` 배경, `border` 경계, radius 6px, `shadow-md`, 최대 폭 ~360–400px.
  - 헤더: 시안 그라디언트 라운드 마크(`P`) + `PIMS Advisor`(Advisor는 `cyan-soft`) + 모노 소형 대문자 서브라벨 "규정·법령 어드바이저 · 운영 콘솔".
- 폼:
  - 아이디 입력칸 + 비밀번호 입력칸 2개. 배경 `input`, border `border`, 포커스 시 border `cyan`.
  - 라벨: 모노 소형 대문자(uppercase, letter-spacing), 색 `text-muted`.
  - 버튼: 배경 `cyan(#0a94ab)`, 흰 글씨, hover `cyan-soft`, disabled 40% opacity.
  - 오류: 아이디/비밀번호 어느 쪽이 틀렸는지 구분하지 않는 **동일한 일반 메시지**("아이디 또는 비밀번호가 올바르지 않습니다.") — 존재 신호 차단. 색 `critical`.
- 폰트: 본문 IBM Plex Sans KR(전역 상속). 모노 라벨은 기존 `font-mono` 토큰 사용 → **JetBrains Mono 미탑재이므로 시스템 모노로 폴백**(기본안). 픽셀 정확도가 필요하면 후속으로 `next/font/google` JetBrains Mono(latin subset) 추가 가능.
- 접근성: 아이디 `autoComplete="username"`, 비밀번호 `autoComplete="current-password"`, 라벨 `htmlFor` 연결, 아이디 `autoFocus`. `prefers-reduced-motion` 존중(애니메이션 최소·무해).

### B. id/pw 인증

1. `lib/env.ts`
   - `ADMIN_USERNAME: z.string().optional()` 추가.
   - 프로덕션 boot-guard 필수 목록(`required`)에 `ADMIN_USERNAME` 추가.
2. `.env.local` / `.env.example`
   - `ADMIN_USERNAME=admin` 추가(관리자/보안 섹션).
3. `app/admin/login/page.tsx`
   - 상태에 `username` 추가, `{ username, password }` JSON 전송.
   - 성공 시 기존과 동일하게 `/admin`으로 이동.
4. `app/api/admin/login/route.ts`
   - body에서 `username`, `password` 파싱(문자열 아니면 빈 문자열).
   - `expectedUser = env.ADMIN_USERNAME`, `expectedPass = env.ADMIN_PASSWORD`.
   - **두 값 모두** 설정돼 있고 **둘 다** `timingSafeEqual` 통과해야 성공. 하나라도 실패 시 동일한 `401 { error: "unauthorized" }`.
     - 두 비교를 각각 수행하되 결과를 AND로 합쳐 조기 반환 분기로 존재/부재 신호가 새지 않게 한다.
   - 성공 시 기존 `signSession(expectedPass, exp)`로 쿠키 발급 — **로직 변경 없음**.
5. `lib/admin-auth.ts` / `middleware.ts`
   - **변경 없음.** 세션 서명·검증은 계속 `ADMIN_PASSWORD` 기반. username은 로그인 시점 게이트에만 관여.

### 데이터 흐름

```
[login form] --{username,password}--> POST /api/admin/login
  route: ADMIN_USERNAME/ADMIN_PASSWORD 둘 다 timingSafeEqual → AND
    실패: 401 (동일 메시지)
    성공: signSession(ADMIN_PASSWORD, exp) → httpOnly 쿠키 set
[browser] --cookie--> /admin/* --> middleware.verifySession(cookie, ADMIN_PASSWORD)
    유효: 통과 / 무효: /admin/login 리다이렉트   (기존 그대로)
```

### 오류 처리

- 로그인 실패: 항상 동일한 401 + 프론트 동일 일반 메시지. 아이디 존재 여부·어느 필드가 틀렸는지 노출 안 함.
- env 누락: `ADMIN_USERNAME`/`ADMIN_PASSWORD` 중 하나라도 없으면 로그인은 항상 401(안전 실패). 프로덕션은 boot-guard가 부팅을 막는다.
- 비-JSON body: 빈 문자열로 간주 → 401.

### 검증 방법 (PoC 기준)

- `pnpm build` 통과 + `pnpm typecheck`.
- `pnpm dev`에서 수동 확인:
  1. 잘못된 id/pw → 동일 401 메시지.
  2. 올바른 id/pw → 쿠키 발급 + `/admin` 진입.
  3. 쿠키 없이 `/admin` 직접 접근 → `/admin/login` 리다이렉트(기존 동작 유지).
  4. 로그인 화면이 시안 콘솔 룩으로 렌더(배경/카드/버튼/포커스 색).

## 범위 밖 (이번 작업에서 제외)

- 대시보드 `app/admin/page.tsx` 리스타일.
- 전역 테마 토큰(globals.css) 변경.
- Supabase Auth 도입, `/api/chat` end-user 로그인 게이트, query_log 기록.
- 다중 관리자 계정(현재는 단일 env 계정 전제).
- `admin_advisor_console_proposal.html`은 참고 시안일 뿐, 대시보드 반영은 별도 과제.

## 참고: Supabase Auth 경로 (미채택)

향후 end-user 로그인(초대·승인 기반 외부기관 계정, 누락된 `/api/chat` 게이트)까지 확장할 때의 정공법:

- `@supabase/ssr`의 `createServerClient` + `signInWithPassword({ email, password })` → Supabase가 HttpOnly 세션 쿠키를 자동 관리(비밀번호 해싱·리프레시·만료 포함).
- `middleware.ts`에서 `supabase.auth.getUser()`로 세션 검증, `app_metadata.role === 'admin'` 등 claim으로 권한 분기.
- 초대·비밀번호 재설정·MFA를 Supabase가 제공 → 자체 구현 부담 감소.
- 관리자 게이트와 end-user 로그인을 같은 기반으로 통일 가능.
- 도입 시 마이그레이션(auth 스키마 연동)·SSR 클라이언트·미들웨어 교체가 수반되므로 **별도 프로젝트(단독 스펙·PR)** 로 진행.
</content>
</invoke>
