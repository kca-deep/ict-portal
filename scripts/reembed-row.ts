import "./_load-env";

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import OpenAI from "openai";
import { getSupabaseAdmin } from "@/lib/db/supabase";

const FILE_PATH =
  process.argv[2] ??
  "data/manuals/parsed/기금사업 결과 평가 등에 관한 지침(과학기술정보통신부훈령)(제258호)(20240315).md";
const CHUNK_INDEX = Number(process.argv[3] ?? "0");

const CHUNK_SIZE = 500;
const EMBED_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const EMBED_DIMS = Number(process.env.EMBEDDING_DIMENSIONS ?? "1024");

function chunkText(text: string, maxLen = CHUNK_SIZE): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = "";
  };

  for (const rawPara of paragraphs) {
    const para = rawPara.trim();
    if (!para) continue;

    if (para.length > maxLen) {
      flush();
      const lines = para.split(/\n/);
      let lineBuf = "";
      for (const line of lines) {
        const candidate = lineBuf ? `${lineBuf}\n${line}` : line;
        if (candidate.length <= maxLen) {
          lineBuf = candidate;
          continue;
        }
        if (lineBuf) {
          chunks.push(lineBuf);
          lineBuf = "";
        }
        if (line.length <= maxLen) {
          lineBuf = line;
        } else {
          for (let i = 0; i < line.length; i += maxLen) {
            chunks.push(line.slice(i, i + maxLen));
          }
        }
      }
      if (lineBuf) chunks.push(lineBuf);
      continue;
    }

    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= maxLen) {
      current = candidate;
    } else {
      flush();
      current = para;
    }
  }
  flush();

  return chunks;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY 누락");
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const supabase = getSupabaseAdmin();

  const fileName = basename(FILE_PATH);
  const title = fileName.replace(/\.md$/i, "");
  const sourceFile = `${title}.pdf`;

  const raw = await readFile(FILE_PATH, "utf8");
  const chunks = chunkText(raw);
  if (CHUNK_INDEX < 0 || CHUNK_INDEX >= chunks.length) {
    throw new Error(`chunk_index ${CHUNK_INDEX} out of range (총 ${chunks.length}개)`);
  }
  const content = chunks[CHUNK_INDEX];

  // 1) 기존 행 조회 (어떤 id가 삭제되는지 확인용)
  const { data: before, error: selErr } = await supabase
    .from("documents")
    .select("id")
    .eq("source", "internal_regulation")
    .eq("title", title)
    .eq("chunk_index", CHUNK_INDEX);
  if (selErr) throw selErr;

  // 2) DELETE
  const { error: delErr } = await supabase
    .from("documents")
    .delete()
    .eq("source", "internal_regulation")
    .eq("title", title)
    .eq("chunk_index", CHUNK_INDEX);
  if (delErr) throw delErr;
  console.log(`삭제: ${before?.length ?? 0}건 (ids=${before?.map((r) => r.id).join(",") ?? "-"})`);

  // 3) EMBED
  console.log(`임베딩: ${EMBED_MODEL} (dim=${EMBED_DIMS}), content_len=${content.length}`);
  const embedRes = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: [content],
    dimensions: EMBED_DIMS,
  });
  const embedding = embedRes.data[0].embedding;

  // 4) INSERT
  const { data: inserted, error: insErr } = await supabase
    .from("documents")
    .insert({
      source: "internal_regulation",
      title,
      content,
      chunk_index: CHUNK_INDEX,
      metadata: { source_file: sourceFile, parsed_from: "kordoc" },
      embedding,
    })
    .select("id, chunk_index")
    .single();
  if (insErr) throw insErr;

  console.log(`재색인 완료: new id=${inserted.id}, chunk_index=${inserted.chunk_index}`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
