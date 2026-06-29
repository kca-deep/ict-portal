// scripts/chat-smoke.mjs — 채팅 라우팅 회귀 하네스 (테스트 프레임워크 부재 대체).
// 사용: node scripts/chat-smoke.mjs            → 8질의 고정 셋
//       node scripts/chat-smoke.mjs "임의 질의"  → 단건
const BASE = process.env.CHAT_BASE ?? "http://localhost:3000";
const FIXED = {
  A: ["중간보고서 진행 절차와 시기는?", "ict기금 전담기관이란", "ict 전담기관이란"],
  B: ["기업회생 절차와 관련 법령대로 내가 진행해야 하는 내용을 알려줘",
      "육아휴직은 며칠까지 쓸 수 있나요?",
      "하도급 대금을 받지 못했을 때 어떻게 대응하나요?",
      "개인정보가 유출되면 며칠 안에 신고해야 하나요?"],
  C: ["오늘 날씨는 어때?"],
};

async function ask(q) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: q }] }),
  });
  const text = await res.text();
  const ev = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const r = ev.find((e) => e.type === "routing");
  const s = ev.find((e) => e.type === "sources");
  const c = ev.find((e) => e.type === "citations");
  const kinds = (s?.data ?? []).map((x) => `${x.metadata?.kind ?? "reg"}:${typeof x.score === "number" ? x.score.toFixed(2) : x.score}`);
  return {
    q,
    route: r?.route ?? "(refuse)",
    score: r?.score?.toFixed?.(3) ?? "-",
    laws: (r?.laws ?? []).map((l) => l.name).join(" | "),
    sources: kinds.join(", ") || "0",
    halluc: c?.hasHallucination ?? false,
  };
}

const args = process.argv.slice(2);
const queries = args.length === 0 || ["A", "B", "C", "all"].includes(args[0])
  ? (args[0] && args[0] !== "all" ? FIXED[args[0]] : [...FIXED.A, ...FIXED.B, ...FIXED.C])
  : args;

for (const q of queries) {
  const r = await ask(q);
  console.log(`[${r.route}] score=${r.score} halluc=${r.halluc} | src=${r.sources} | laws=${r.laws} | ${q}`);
}
