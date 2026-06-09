import { NextRequest } from "next/server";
import { embed } from "@/lib/ai/embedding";
import { getSupabaseAdmin } from "@/lib/db/supabase";

export const runtime = "nodejs";
export const maxDuration = 300;

type IngestDoc = {
  source: string;
  doc_type?: string;
  title?: string;
  content: string;
  source_ref?: string;
  chunk_index?: number;
  metadata?: Record<string, unknown>;
};

type IngestBody = {
  documents: IngestDoc[];
};

const BATCH = 64;

export async function POST(req: NextRequest) {
  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const docs = body.documents ?? [];
  if (docs.length === 0) return Response.json({ inserted: 0 });

  const supabase = getSupabaseAdmin();
  let inserted = 0;

  for (let i = 0; i < docs.length; i += BATCH) {
    const chunk = docs.slice(i, i + BATCH);
    const texts = chunk.map((d) => `${d.title ?? ""}\n${d.content}`);

    let embeddings: number[][];
    try {
      embeddings = await embed(texts);
    } catch (err) {
      return Response.json(
        { error: `embedding failed at batch ${i}: ${(err as Error).message}`, inserted },
        { status: 500 }
      );
    }

    const rows = chunk.map((d, idx) => ({
      source: d.source,
      doc_type: d.doc_type ?? null,
      title: d.title ?? null,
      content: d.content,
      chunk_index: d.chunk_index ?? 0,
      source_ref: d.source_ref ?? null,
      metadata: d.metadata ?? {},
      embedding: embeddings[idx],
    }));

    const { data, error } = await supabase
      .from("documents")
      .insert(rows)
      .select("id");

    if (error) {
      return Response.json(
        { error: `insert failed at batch ${i}: ${error.message}`, inserted },
        { status: 500 }
      );
    }
    inserted += data?.length ?? 0;
  }

  return Response.json({ inserted });
}
