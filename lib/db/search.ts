import { getSupabaseAdmin } from "@/lib/db/supabase";
import { embedQuery } from "@/lib/ai/embedding";
import { env } from "@/lib/env";

export type DocumentHit = {
  id: number;
  source: string;
  doc_type: string | null;
  title: string | null;
  content: string;
  source_ref: string | null;
  metadata: Record<string, unknown>;
  rrf_score: number;
};

export async function hybridSearch(
  query: string,
  matchCount: number = env.RETRIEVAL_TOP_K
): Promise<DocumentHit[]> {
  const embedding = await embedQuery(query);
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: embedding,
    match_count: matchCount,
  });

  if (error) throw new Error(`hybrid_search RPC failed: ${error.message}`);
  return (data ?? []) as DocumentHit[];
}

export async function regulationSearch(
  query: string,
  matchCount: number = env.RETRIEVAL_TOP_K
): Promise<DocumentHit[]> {
  const embedding = await embedQuery(query);
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.rpc("regulation_search", {
    query_text: query,
    query_embedding: embedding,
    match_count: matchCount,
  });

  if (error) throw new Error(`regulation_search RPC failed: ${error.message}`);
  return (data ?? []) as DocumentHit[];
}
