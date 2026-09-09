import { checkBotId } from "botid/server";

/**
 * BotID 판정 래퍼 — SDK 가 던지는 인프라 오류를 "봇 아님"으로 흡수한다.
 *
 * `checkBotId()` 는 Vercel 밖(로컬 `next start`, 컨테이너 스모크)에서
 * `Must be deployed on Vercel to set response headers` 를 던진다. 라우트 최상단에서
 * 부르므로 이 예외 하나가 /api/chat 전체를 500 으로 만들고, CLAUDE.md 가 요구하는
 * 배포 전 프로덕션 모드 스모크(챗 전송 1회)를 통과할 수 없게 한다 — 실측 2026-09.
 *
 * 봇 차단은 다층 방어의 첫 겹일 뿐이고 뒤에 레이트리밋·비용가드가 그대로 남으므로,
 * 판정 자체가 불가능한 상황에서는 요청을 죽이는 대신 통과시키고 로그만 남긴다
 * (fail-open). Vercel 위에서는 이 경로에 닿지 않아 차단 동작이 달라지지 않는다.
 */
export async function safeCheckBotId(
  route: string,
): Promise<{ isBot: boolean; isHuman: boolean }> {
  try {
    return await checkBotId();
  } catch (e) {
    console.warn(
      `[${route}] botid unavailable — 판정 생략:`,
      e instanceof Error ? e.message : String(e),
    );
    return { isBot: false, isHuman: true };
  }
}
