/**
 * 실제 /api/chat 엔드포인트를 질의해 답변·라우팅·참조문서·인용검증을 캡처.
 * 우리 파이프라인의 end-to-end 답변 품질 확인용.
 *
 * 사전: dev 서버가 http://localhost:3000 에 떠 있어야 함.
 * 실행: pnpm exec tsx scripts/test-chat-e2e.ts "야근수당 안 주면 불법인가요?"
 */
const BASE = process.env.CHAT_BASE ?? "http://localhost:3000";

async function ask(query: string) {
  console.log(`\n${"═".repeat(72)}\n질의: "${query}"\n${"═".repeat(72)}`);
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: query }] }),
  });
  if (!res.ok) {
    console.log(`HTTP ${res.status}: ${await res.text()}`);
    return;
  }
  const text = await res.text();
  let answer = "";
  let routing: any = null;
  let sources: any[] = [];
  let citations: any = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "delta") answer += ev.text;
    else if (ev.type === "routing") routing = ev;
    else if (ev.type === "sources") sources = ev.data;
    else if (ev.type === "citations") citations = ev;
  }

  console.log(
    `\n[라우팅] ${routing?.route === "law" ? "⚖️ 법령" : "📘 내부규정"} (maxScore ${routing?.score?.toFixed?.(3) ?? "?"})`,
  );
  console.log(`\n[답변]\n${answer}`);

  console.log(`\n[참조문서] ${sources.length}건`);
  for (const s of sources) {
    const kind = (s.metadata?.kind as string) ?? "regulation";
    const head = s.content.split("\n").find((l: string) => l.startsWith("[")) ?? s.content.slice(0, 40);
    console.log(`  · [${kind}] ${s.title} (관련도 ${Math.round((s.score ?? 0) * 100)}%) ${head}`);
  }

  if (citations) {
    console.log(`\n[인용검증] 환각=${citations.hasHallucination}`);
    for (const v of citations.data) {
      const mark = v.status === "verified" ? "✓" : v.status === "not_found" ? "✗" : "⚠";
      console.log(`  ${mark} ${v.raw} → ${v.status}${v.note ? ` (${v.note})` : ""}`);
    }
  }
}

async function main() {
  const q = process.argv[2];
  const queries = q ? [q] : ["야근수당 안 주면 불법인가요?", "직장 내 괴롭힘 신고하면 어떻게 되나요?"];
  for (const query of queries) await ask(query);
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
