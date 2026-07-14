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
    else if (ev.type === "sources") sources = ev.data;
    else if (ev.type === "citations") citations = ev;
  }

  // 통합 파이프라인(routing 이벤트 폐지): 소스 구성으로 주입 상태를 요약한다.
  const mix = sources.reduce((m: Record<string, number>, s: any) => {
    const k = (s.metadata?.kind as string) ?? "regulation";
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
  const top = sources[0]?.score;
  console.log(
    `\n[통합 주입] ${sources.length}건 (${Object.entries(mix).map(([k, n]) => `${k} ${n}`).join(", ") || "없음 — 근거 미주입/범위밖"})` +
      (typeof top === "number" ? ` maxScore=${top.toFixed(3)}` : ""),
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
