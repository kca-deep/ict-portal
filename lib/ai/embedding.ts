import { CohereClient } from "cohere-ai";
import { env } from "@/lib/env";

const cohere = new CohereClient({ token: env.COHERE_API_KEY });

export type EmbeddingInputType = "search_query" | "search_document";

export async function embed(
  texts: string[],
  inputType: EmbeddingInputType
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await cohere.v2.embed({
    model: env.EMBEDDING_MODEL,
    texts,
    inputType,
    embeddingTypes: ["float"],
    outputDimension: env.EMBEDDING_DIMENSIONS,
  });
  return response.embeddings.float ?? [];
}

export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await embed([text], "search_query");
  if (!vec) throw new Error("embedding returned no vector");
  return vec;
}
