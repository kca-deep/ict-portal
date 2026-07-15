import { Resend } from "resend";
import { env } from "@/lib/env";

// 비용·남용 임계치 경고 이메일(Resend). 키/주소가 하나라도 없으면 no-op —
// 로컬·미구성 환경에서 조용히 통과한다(알림 실패가 사용자 요청을 막지 않는다).
export async function sendCostAlert(
  subject: string,
  text: string,
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL_FROM || !env.ALERT_EMAIL_TO) return;
  try {
    const resend = new Resend(env.RESEND_API_KEY);
    await resend.emails.send({
      from: env.ALERT_EMAIL_FROM,
      to: env.ALERT_EMAIL_TO,
      subject,
      text,
    });
  } catch (err) {
    console.error("[alert] email send failed:", (err as Error).message);
  }
}
