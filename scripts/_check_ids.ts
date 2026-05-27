import "./_load-env";
import { getSupabaseAdmin } from "@/lib/db/supabase";

async function main() {
  const s = getSupabaseAdmin();
  const { data: minRow } = await s.from("regulation").select("id").order("id", { ascending: true }).limit(1);
  const { data: maxRow } = await s.from("regulation").select("id").order("id", { ascending: false }).limit(1);
  const { count } = await s.from("regulation").select("*", { count: "exact", head: true });
  console.log(`rows=${count}  min_id=${minRow?.[0]?.id}  max_id=${maxRow?.[0]?.id}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
