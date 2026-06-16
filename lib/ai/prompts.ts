import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 시스템 프롬프트는 `prompts/prompts.md` 단일 파일로 관리한다(비개발자도 편집 가능).
 * 섹션은 `<!-- prompt:키 -->` 마커로 구분 — 마크다운에서 렌더되지 않고 본문과
 * 충돌하지 않는다. 모듈 로드 시 1회 파싱해 상수로 노출하므로 소비처(llm-router)
 * 인터페이스는 불변. 경로가 동적이라 next.config.ts의 `outputFileTracingIncludes`로
 * prompts/** 번들 동봉을 보장한다.
 */
function loadPrompts(): Record<string, string> {
  const path = join(process.cwd(), "prompts", "prompts.md");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `시스템 프롬프트 로드 실패: ${path} (${(err as Error).message})`,
    );
  }

  const sections: Record<string, string> = {};
  const marker = /<!--\s*prompt:([\w-]+)\s*-->/g;
  const matches = [...raw.matchAll(marker)];
  for (let i = 0; i < matches.length; i++) {
    const key = matches[i][1];
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    sections[key] = raw.slice(start, end).trim();
  }
  return sections;
}

function requireSection(sections: Record<string, string>, key: string): string {
  const text = sections[key];
  if (!text) {
    throw new Error(`시스템 프롬프트 섹션 누락: prompts/prompts.md <!-- prompt:${key} -->`);
  }
  return text;
}

const PROMPTS = loadPrompts();

export const SYSTEM_PROMPT = requireSection(PROMPTS, "advisor");
export const CHAT_SYSTEM_PROMPT = requireSection(PROMPTS, "chat");
export const RELEVANCE_GATE_PROMPT = requireSection(PROMPTS, "relevance-gate");
