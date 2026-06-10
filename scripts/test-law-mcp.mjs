/**
 * korean-law-mcp (chrisryugj) 자체호스팅 MCP 연결 테스트
 *
 * 전역 설치한 korean-law-mcp 서버를 stdio로 띄워 MCP 프로토콜 핸드셰이크를 수행하고
 * (initialize → tools/list → tools/call), 우리 챗봇에 쓸 핵심 도구를 실증한다:
 *   - search_law       (법령 식별 · 참조문서)
 *   - get_law_text     (조문 본문 · 답변 근거)
 *   - verify_citations (인용 검증 · 환각 차단)
 *
 * 실행: node scripts/test-law-mcp.mjs [서버 index.js 경로]
 * 키:   .env.local 의 LAW_GO_KR_API_KEY 를 MCP 의 LAW_OC 로 주입.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

// OC 키: .env.local 에서 추출
let oc = process.env.LAW_OC ?? "";
try {
  const m = readFileSync(".env.local", "utf8").match(/^LAW_GO_KR_API_KEY=(.*)$/m);
  if (m) oc = m[1].trim();
} catch {}

const SERVER =
  process.argv[2] ??
  "C:\\Users\\COMTREE\\AppData\\Roaming\\npm\\node_modules\\korean-law-mcp\\build\\index.js";

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, LAW_OC: oc },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
let stderr = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // JSON-RPC 가 아닌 출력은 무시
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

function rpc(method, params, notify = false) {
  if (notify) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    return Promise.resolve();
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 25000);
  });
}

const textOf = (r) =>
  (r?.result?.content ?? []).map((x) => (x.type === "text" ? x.text : "")).join("\n");

async function main() {
  console.log(`OC 키: ${oc || "(없음)"} · 서버: ${SERVER}\n`);

  // 1) initialize
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ict-portal-mcp-test", version: "0.0.1" },
  });
  console.log("=== initialize ===");
  console.log("  serverInfo:", JSON.stringify(init.result?.serverInfo));
  console.log("  protocolVersion:", init.result?.protocolVersion);
  await rpc("notifications/initialized", {}, true);

  // 2) tools/list
  const tl = await rpc("tools/list", {});
  const tools = tl.result?.tools ?? [];
  console.log(`\n=== tools/list: ${tools.length}개 ===`);
  console.log("  " + tools.map((t) => t.name).join(", "));
  const want = [
    "search_law",
    "get_law_text",
    "verify_citations",
    "impact_map",
    "search_decisions",
    "get_decision_text",
    "chain_full_research",
  ];
  console.log(
    "  핵심: " +
      want.map((w) => `${w}=${tools.some((t) => t.name === w) ? "✓" : "✗"}`).join("  "),
  );

  // 3) search_law
  const sl = await rpc("tools/call", {
    name: "search_law",
    arguments: { query: "저작권법" },
  });
  console.log("\n=== tools/call search_law(저작권법) ===");
  console.log(textOf(sl).slice(0, 450));

  // 4) get_law_text — 저작권법 제24조의2(공공저작물의 자유이용)
  const gt = await rpc("tools/call", {
    name: "get_law_text",
    arguments: { mst: "283335", jo: "제24조의2" },
  });
  console.log("\n=== tools/call get_law_text(저작권법 제24조의2) ===");
  console.log(textOf(gt).slice(0, 650));

  // 5) verify_citations — 인용 검증 (실존 제24조의2 + 가짜 제999조)
  const vcTool = tools.find((t) => t.name === "verify_citations");
  const vcArg =
    vcTool?.inputSchema?.required?.[0] ??
    Object.keys(vcTool?.inputSchema?.properties ?? { text: 1 })[0];
  const vc = await rpc("tools/call", {
    name: "verify_citations",
    arguments: {
      [vcArg]:
        "저작권법 제24조의2(공공저작물의 자유이용)에 따라 자유 이용이 가능하다. 또한 저작권법 제999조에 따라 처벌된다.",
    },
  });
  console.log(`\n=== tools/call verify_citations (arg='${vcArg}', 가짜 제999조 포함) ===`);
  console.log(textOf(vc).slice(0, 650));

  console.log("\n✅ MCP 연결·핸드셰이크·도구호출 성공");
  child.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("\n✗ ERROR:", e.message);
  if (stderr) console.error("stderr:", stderr.slice(0, 1200));
  child.kill();
  process.exit(1);
});
