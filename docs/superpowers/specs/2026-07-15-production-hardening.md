# 상용화 보안 하드닝 (no-login 기준)

> 결정(2026-07-15): ① 인증 모델은 **no-login 으로 통일**(사용자 로그인 없음, IP 기반 식별),
> ② 하드닝은 **PoC 가 아니라 상용화 수준**. 공개 챗 엔드포인트가 유료 LLM 을 호출하므로
> 레이트리밋·비용가드·봇차단이 **핵심 방어선(load-bearing)** 이다.

## 결정된 인프라

| 영역 | 선택 |
|---|---|
| 레이트리밋·비용가드 저장소 | **Upstash Redis** (`@upstash/ratelimit` + `@upstash/redis`) |
| 알림 채널 | **이메일** (`resend`) |
| 봇/DDoS | **Vercel WAF + BotID** (`botid` SDK + 대시보드 WAF 룰) |

## 실행 순서 (각 단계 = 독립 커밋, 끝에 typecheck)

1. **env 스키마** — Upstash·Resend·예산·알림 키 추가 + 프로덕션 필수화(superRefine).
2. **레이트리밋 → Upstash** (`lib/security/ratelimit.ts` 재작성) — IP 분당(슬라이딩)·IP 일일·전역 일일.
   프로덕션 **fail-closed**(리미터 오류 시 차단 — 비용 보호 우선, 무인증이라).
3. **비용 가드** (`lib/security/cost-guard.ts` 신규) — IP·전역 **일일 토큰 예산** Redis 집계.
   초과 시 429. 임계치(기본 80%) 교차 시 이메일 알림(하루 1회, Redis 플래그로 디듈).
4. **이메일 알림** (`lib/alerts/email.ts` 신규) — Resend. 키 없으면 no-op(로컬 안전).
5. **BotID** — `next.config` 를 `withBotId` 로 래핑 + `instrumentation-client.ts` 로 보호 경로 등록 +
   `/api/chat` 서버에서 `checkBotId()`. WAF 룰은 대시보드(별도 안내).
6. **CSP nonce 화** — 미들웨어에서 요청별 nonce 발급, `script-src 'nonce-…'`(엄격).
   `style-src` 는 인라인 style 속성 때문에 `'unsafe-inline'` 유지(업계 통용).
7. **관리자 쿠키 하드닝** — `__Host-` 프리픽스, 서명키 분리(`ADMIN_SESSION_SECRET`, 폴백 ADMIN_PASSWORD),
   로그인 시도 레이트리밋(Upstash 재사용).
8. **문서 정합** — `docs/07`·`docs/00`·`CLAUDE.md` 를 no-login 상용 기준으로 갱신.

## 프로비저닝 (사용자 작업 — 코드와 별개)

- Upstash: Vercel Marketplace → Redis 생성 → `UPSTASH_REDIS_REST_URL`·`UPSTASH_REDIS_REST_TOKEN` 자동 주입.
- Resend: 계정 + 도메인 인증 → `RESEND_API_KEY`, `ALERT_EMAIL_FROM`(인증 도메인), `ALERT_EMAIL_TO`.
- Vercel WAF: 대시보드 → Firewall → 레이트 룰 + BotID 활성.
