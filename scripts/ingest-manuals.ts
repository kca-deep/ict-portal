import "./_load-env";

import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import OpenAI from "openai";
import { getSupabaseAdmin } from "@/lib/db/supabase";

const PARSED_DIR = "data/manuals/parsed";
const CHUNK_SIZE = 500;
const EMBED_BATCH = 32;
const INSERT_BATCH = 50;
const EMBED_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const EMBED_DIMS = Number(process.env.EMBEDDING_DIMENSIONS ?? "1024");

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY 누락 (.env.local 확인)");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = getSupabaseAdmin();

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

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: texts,
    dimensions: EMBED_DIMS,
  });
  return res.data.map((d) => d.embedding);
}

type DocRow = {
  source: string;
  title: string;
  content: string;
  chunk_index: number;
  metadata: Record<string, unknown>;
  embedding: number[];
};

async function ingestFile(filePath: string) {
  const fileName = basename(filePath);
  const title = fileName.replace(/\.md$/i, "");
  const sourceFile = `${title}.pdf`;

  const raw = await readFile(filePath, "utf8");
  const chunks = chunkText(raw);
  if (chunks.length === 0) {
    console.log(`[${fileName}] 빈 파일 — 건너뜀`);
    return;
  }

  // 동일 title 기존 행 제거 (재실행 시 중복 방지)
  const { error: delErr } = await supabase
    .from("documents")
    .delete()
    .eq("source", "internal_regulation")
    .eq("title", title);
  if (delErr) {
    throw new Error(`기존 행 삭제 실패: ${delErr.message}`);
  }

  console.log(`[${fileName}] ${chunks.length}개 청크 임베딩 시작 (모델=${EMBED_MODEL}, dim=${EMBED_DIMS})`);

  const rows: DocRow[] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const embeddings = await embedBatch(batch);
    batch.forEach((content, j) => {
      rows.push({
        source: "internal_regulation",
        title,
        content,
        chunk_index: i + j,
        metadata: { source_file: sourceFile, parsed_from: "kordoc" },
        embedding: embeddings[j],
      });
    });
    process.stdout.write(`  임베딩 ${Math.min(i + EMBED_BATCH, chunks.length)}/${chunks.length}\r`);
  }
  process.stdout.write("\n");

  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    const { error } = await supabase.from("documents").insert(batch);
    if (error) {
      throw new Error(`INSERT 실패 (offset=${i}): ${error.message}`);
    }
  }

  console.log(`[${fileName}] 청크 ${rows.length}개 색인 완료`);
}

async function main() {
  let entries: string[];
  try {
    entries = await readdir(PARSED_DIR);
  } catch (err) {
    throw new Error(`${PARSED_DIR} 폴더 없음 — kordoc 파싱부터 먼저 실행하세요.`);
  }

  const files = entries
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .map((f) => join(PARSED_DIR, f));

  if (files.length === 0) {
    console.log("색인할 .md 파일 없음.");
    return;
  }

  console.log(`총 ${files.length}개 파일 색인 시작\n`);
  let ok = 0;
  let fail = 0;
  for (const f of files) {
    try {
      await ingestFile(f);
      ok++;
    } catch (err) {
      console.error(`[${basename(f)}] 실패:`, err instanceof Error ? err.message : err);
      fail++;
    }
  }
  console.log(`\n색인 종료. 성공=${ok} 실패=${fail}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
