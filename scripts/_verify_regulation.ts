import "./_load-env";
import { getSupabaseAdmin } from "@/lib/db/supabase";

async function main() {
  const s = getSupabaseAdmin();
  const { count } = await s.from("regulation").select("*", { count: "exact", head: true });
  console.log("total rows:", count);

  const { data: groups } = await s.from("regulation").select("metadata").limit(500);
  const byGroup: Record<string, number> = {};
  for (const r of groups ?? []) {
    const g = (r.metadata as { group_title?: string } | null)?.group_title ?? "unknown";
    byGroup[g] = (byGroup[g] ?? 0) + 1;
  }
  console.log("\n그룹별 청크 수:");
  for (const [g, n] of Object.entries(byGroup).sort()) {
    console.log(`  ${n.toString().padStart(3)}  ${g}`);
  }

  const { data: sample } = await s
    .from("regulation")
    .select("title,doc_type,chunk_index,source_ref,content,metadata")
    .eq("source_ref", "기금사업비 산정 및 정산 등에 관한 지침 [별표 1] 비ㆍ세목별 사업비 산정 기준.pdf")
    .order("chunk_index")
    .limit(2);
  console.log("\n샘플 (별표 1, 2 청크):");
  for (const r of sample ?? []) {
    console.log(`  chunk_index=${r.chunk_index}  doc_type=${r.doc_type}`);
    console.log(`  metadata=${JSON.stringify(r.metadata).slice(0, 200)}`);
    console.log(`  content[:120]: ${(r.content as string).slice(0, 120)}`);
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
