import OpenAI from "openai";
import { env } from "@/lib/env";

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    if (!env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY 누락 (.env.local 확인)");
    }
    _openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _openai;
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await getOpenAI().embeddings.create({
    model: env.EMBEDDING_MODEL,
    input: texts,
    dimensions: env.EMBEDDING_DIMENSIONS,
  });
  return res.data.map((d) => d.embedding);
}

export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await embed([text]);
  if (!vec) throw new Error("embedding returned no vector");
  return vec;
}
