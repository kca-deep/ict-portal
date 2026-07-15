import { getSupabaseAdmin } from "@/lib/db/supabase";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { error } = await getSupabaseAdmin()
      .from("documents")
      .select("id", { count: "exact", head: true });
    if (error) {
      // 헬스체크는 무인증·공개 엔드포인트 — DB 오류 원문을 노출하지 않고 서버
      // 로그에만 남긴다(docs/07 §11). 응답은 상태 불리언만.
      console.error("[health] supabase check failed:", error.message);
      return Response.json({ ok: false, supabase: false }, { status: 503 });
    }
    return Response.json({ ok: true, supabase: true });
  } catch (err) {
    console.error("[health] check threw:", (err as Error).message);
    return Response.json({ ok: false }, { status: 503 });
  }
}
