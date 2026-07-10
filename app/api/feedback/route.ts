import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/supabase";

// 답변 피드백(👍/👎)을 query_log.feedback 에 기록한다. queryId 는 /api/chat 의
// meta 이벤트로 클라이언트가 받은 삽입 행 id. value 는 +1(도움됨)/0(취소)/-1(아쉬움).
// service_role 로 갱신하며(RLS 우회), 내부 오류 메시지는 노출하지 않는다.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let queryId: unknown;
  let value: unknown;
  try {
    const body = (await req.json()) as { queryId?: unknown; value?: unknown };
    queryId = body?.queryId;
    value = body?.value;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (
    typeof queryId !== "number" ||
    !Number.isInteger(queryId) ||
    queryId <= 0 ||
    typeof value !== "number" ||
    ![-1, 0, 1].includes(value)
  ) {
    return NextResponse.json({ error: "invalid input" }, { status: 400 });
  }

  try {
    const { error } = await getSupabaseAdmin()
      .from("query_log")
      .update({ feedback: value })
      .eq("id", queryId);
    if (error) {
      console.error("[feedback] update failed:", error.message);
      return NextResponse.json({ error: "update failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[feedback] update threw:", (err as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
