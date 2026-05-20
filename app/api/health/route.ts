import { getSupabaseAdmin } from "@/lib/db/supabase";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { error } = await getSupabaseAdmin()
      .from("documents")
      .select("id", { count: "exact", head: true });
    if (error) {
      return Response.json(
        { ok: false, supabase: false, error: error.message },
        { status: 503 }
      );
    }
    return Response.json({ ok: true, supabase: true });
  } catch (err) {
    return Response.json(
      { ok: false, error: (err as Error).message },
      { status: 503 }
    );
  }
}
