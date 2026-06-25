import "./_load-env";

import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import OpenAI from "openai";
import { getSupabaseAdmin } from "@/lib/db/supabase";

const PARSED_DIR = "data/manuals/parsed";
const TARGET_TABLE = "regulation";
const CHUNK_TARGET = 800; // 한 조가 보통 200~500자, 큰 조는 분할
const CHUNK_MAX = 1500;
const EMBED_BATCH = 32;
const INSERT_BATCH = 50;
const EMBED_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const EMBED_DIMS = Number(process.env.EMBEDDING_DIMENSIONS ?? "1024");

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY 누락 (.env.local 확인)");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = getSupabaseAdmin();

type Frontmatter = {
  group?: number;
  group_title?: string;
  order?: number;
  attachment_type?: "main" | "별지" | "별표";
  attachment_number?: number;
  attachment_title?: string;
  source_pdf?: string;
};

function parseFrontmatter(text: string): { meta: Frontmatter; body: string } {
  // CRLF/LF 모두 대응. 파일 시작이 '---' 줄로 열리고 같은 마커로 닫히는 YAML 블록
  const normalized = text.replace(/\r\n/g, "\n");
  const m = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: normalized };
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let v: string = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (/^-?\d+$/.test(v)) {
      meta[kv[1]] = parseInt(v, 10);
    } else {
      meta[kv[1]] = v;
    }
  }
  return { meta: meta as Frontmatter, body: m[2].trimStart() };
}

/** 조(제N조) 헤더 단위로 분할. nested 가 너무 크면 항(①②③) 단위로 추가 분할. */
function chunkByArticle(body: string): { content: string; article?: string }[] {
  const chunks: { content: string; article?: string }[] = [];
  // 조 헤더: ## 또는 ### 또는 #### 시작 + 제N조 또는 제N조의M
  const lines = body.split("\n");

  const headers: { idx: number; line: string; art: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{2,6}\s+(제\d+조(?:의\d+)?\s*\([^)]+\))/);
    if (m) headers.push({ idx: i, line: lines[i], art: m[1] });
  }

  if (headers.length === 0) {
    // 조 헤더가 없는 문서 (별지/별표/표기방안 등) — 표는 '행' 단위로 분할(헤더행 prepend),
    // 표가 아닌 산문은 단락 단위로. 큰 표가 한 청크로 뭉쳐 임베딩이 희석되는 문제 방지.
    return splitMarkdownTables(body).map((c) => ({ content: c }));
  }

  // 첫 조 이전 prose (제1장 총칙 같은 챕터 헤더, 시행일 메타 등) 도 1개 청크로
  if (headers[0].idx > 0) {
    const pre = lines.slice(0, headers[0].idx).join("\n").trim();
    if (pre) chunks.push({ content: pre });
  }

  for (let h = 0; h < headers.length; h++) {
    const start = headers[h].idx;
    const end = h + 1 < headers.length ? headers[h + 1].idx : lines.length;
    const block = lines.slice(start, end).join("\n").trim();
    if (!block) continue;

    if (block.length <= CHUNK_MAX) {
      chunks.push({ content: block, article: headers[h].art });
      continue;
    }

    // 너무 큰 조 → 항(①②③) 단위로 분할. 각 청크에는 조 헤더 prepend
    const subs = splitByParagraphMarker(block);
    for (const sub of subs) {
      chunks.push({ content: sub, article: headers[h].art });
    }
  }

  return chunks;
}

/** 항(①②③) 마커 기준으로 분할. 조 헤더는 각 sub-chunk 에 prepend 됨. */
function splitByParagraphMarker(block: string): string[] {
  const lines = block.split("\n");
  const headerLine = lines[0]; // ### 제N조(...)
  const body = lines.slice(1).join("\n");
  // 항 마커 위치 찾기
  const markerRe = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]\s/m;
  const parts: string[] = [];
  let buf = "";
  for (const line of body.split("\n")) {
    if (markerRe.test(line) && buf.trim()) {
      parts.push(buf.trim());
      buf = line + "\n";
    } else {
      buf += line + "\n";
    }
  }
  if (buf.trim()) parts.push(buf.trim());

  if (parts.length === 0) return [block];
  return parts.map((p) => `${headerLine}\n${p}`);
}

/**
 * 마크다운 파이프 표를 '행' 단위로 분할. 각 데이터행에 헤더행+구분선을 prepend 해
 * 열(컬럼) 맥락을 유지한다. 표가 아닌 구간은 splitByParagraph 로 처리.
 * 큰 표(예: [별표 1] 비·세목별 산정기준)가 한 청크로 뭉쳐 임베딩이 희석되는 문제를 막는다.
 */
function splitMarkdownTables(body: string): string[] {
  const lines = body.split("\n");
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l: string) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  const out: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const s = buf.join("\n").trim();
    if (s) out.push(...splitByParagraph(s));
    buf = [];
  };
  for (let i = 0; i < lines.length; ) {
    // 표 시작 = 데이터 행 + 바로 다음 줄이 구분선(|---|)
    if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      flush();
      const header = lines[i];
      const sep = lines[i + 1];
      i += 2;
      while (i < lines.length && isRow(lines[i])) {
        if (!isSep(lines[i])) out.push(`${header}\n${sep}\n${lines[i].trim()}`);
        i++;
      }
    } else {
      buf.push(lines[i]);
      i++;
    }
  }
  flush();
  return out;
}

/** fallback: 빈 줄 기준 단락 분할 + 크기 합치기. */
function splitByParagraph(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const out: string[] = [];
  let cur = "";
  for (const p of paragraphs) {
    const t = p.trim();
    if (!t) continue;
    const cand = cur ? `${cur}\n\n${t}` : t;
    if (cand.length <= CHUNK_TARGET) {
      cur = cand;
    } else {
      if (cur) out.push(cur);
      cur = t;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: texts,
    dimensions: EMBED_DIMS,
  });
  return res.data.map((d) => d.embedding);
}

type Row = {
  source: string;
  doc_type: string | null;
  title: string | null;
  content: string;
  chunk_index: number;
  source_ref: string | null;
  metadata: Record<string, unknown>;
  embedding: number[];
};

async function ingestFile(filePath: string): Promise<{ ok: boolean; chunks: number }> {
  const fileName = basename(filePath);
  const title = fileName.replace(/\.md$/i, "");
  const raw = await readFile(filePath, "utf8");
  const { meta, body } = parseFrontmatter(raw);
  const sourcePdf = meta.source_pdf ?? `${title}.pdf`;

  const chunked = chunkByArticle(body);
  if (chunked.length === 0) {
    console.log(`[${fileName}] 빈 본문 — 건너뜀`);
    return { ok: true, chunks: 0 };
  }

  // 동일 source_ref 기존 행 제거 (재실행 시 중복 방지)
  const { error: delErr } = await supabase
    .from(TARGET_TABLE)
    .delete()
    .eq("source_ref", sourcePdf);
  if (delErr) throw new Error(`기존 행 삭제 실패: ${delErr.message}`);

  console.log(
    `[${fileName}] ${chunked.length}개 청크 임베딩 시작 (모델=${EMBED_MODEL}, dim=${EMBED_DIMS})`,
  );

  const docType = meta.attachment_type ?? null;
  const baseMeta: Record<string, unknown> = {
    group: meta.group ?? null,
    group_title: meta.group_title ?? null,
    order: meta.order ?? null,
    attachment_type: meta.attachment_type ?? null,
    attachment_number: meta.attachment_number ?? null,
    attachment_title: meta.attachment_title ?? null,
    source_pdf: sourcePdf,
  };

  const rows: Row[] = [];
  for (let i = 0; i < chunked.length; i += EMBED_BATCH) {
    const batch = chunked.slice(i, i + EMBED_BATCH);
    const texts = batch.map((c) => c.content);
    const embeddings = await embedBatch(texts);
    batch.forEach((c, j) => {
      rows.push({
        source: "internal_regulation",
        doc_type: docType,
        title,
        content: c.content,
        chunk_index: i + j,
        source_ref: sourcePdf,
        metadata: { ...baseMeta, ...(c.article ? { article: c.article } : {}) },
        embedding: embeddings[j],
      });
    });
    process.stdout.write(`  임베딩 ${Math.min(i + EMBED_BATCH, chunked.length)}/${chunked.length}\r`);
  }
  process.stdout.write("\n");

  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    const { error } = await supabase.from(TARGET_TABLE).insert(batch);
    if (error) throw new Error(`INSERT 실패 (offset=${i}): ${error.message}`);
  }

  console.log(`[${fileName}] 청크 ${rows.length}개 색인 완료`);
  return { ok: true, chunks: rows.length };
}

async function main(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(PARSED_DIR);
  } catch {
    throw new Error(`${PARSED_DIR} 폴더 없음`);
  }

  const files = entries
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .sort()
    .map((f) => join(PARSED_DIR, f));

  if (files.length === 0) {
    console.log("색인할 .md 파일 없음.");
    return;
  }

  console.log(`총 ${files.length}개 파일 색인 시작 (테이블=${TARGET_TABLE})\n`);
  let ok = 0;
  let fail = 0;
  let totalChunks = 0;
  for (const f of files) {
    try {
      const r = await ingestFile(f);
      if (r.ok) ok++;
      totalChunks += r.chunks;
    } catch (err) {
      console.error(`[${basename(f)}] 실패:`, err instanceof Error ? err.message : err);
      fail++;
    }
  }
  console.log(`\n색인 종료. 성공=${ok}  실패=${fail}  총 청크=${totalChunks}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
