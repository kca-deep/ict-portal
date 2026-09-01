import ExcelJS from "exceljs";
import type { QueryLogExportItem, QueryLogFilter } from "@/lib/db/query-log";

// 쿼리로그 엑셀(.xlsx) 생성. 관리자 대시보드의 "엑셀 다운로드" 가 현재 필터 그대로
// 호출한다(표에 보이는 모집단 = 파일에 담기는 모집단).
//
// 멀티턴 대화: query_log 는 "요청 1건 = 1행"이라 같은 대화(session_id)가 여러 행으로
// 흩어진다. 엑셀에서 대화 흐름을 읽을 수 있도록 행마다 대화 회차(그 대화의 몇 번째
// 질문인지)와 그 대화의 총 질의 수를 함께 넣는다. 회차는 채팅 클라이언트가 보낸
// 히스토리 길이(message_count = 2×(회차-1)+1)에서 계산하고, 값이 없는 옛 행은 세션
// 안에서 시간순 등수로 대신한다. 총 질의 수는 "이번 내보내기 범위 안" 기준이다
// (기간·필터로 잘린 대화는 그만큼만 세어진다).

const KST_OFFSET_MS = 9 * 3600 * 1000;

/** UTC 저장 타임스탬프를 KST 벽시계 문자열로. 엑셀에서 그대로 읽히도록 텍스트로 넣는다. */
function fmtKst(iso: string): string {
  const d = new Date(new Date(iso).getTime() + KST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

// 엑셀 셀 상한은 32,767자. 답변 전문이 넘치면 잘라내되 잘렸음을 본문에 남긴다.
const CELL_MAX = 32_000;
function clip(s: string | null | undefined): string {
  if (!s) return "";
  return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX)}…(이하 생략)` : s;
}

const ROUTE_LABEL: Record<string, string> = {
  unified: "통합",
  regulation: "규정",
  law: "법령",
  out_of_scope: "범위밖",
};

function feedbackLabel(v: number | null): string {
  return v === 1 ? "만족" : v === -1 ? "불만족" : "";
}

type TurnInfo = { turn: number; sessionTurns: number };

/**
 * 행별 대화 회차·대화 총 질의 수를 계산한다.
 * session_id 가 없는 옛 행은 각각 단독 대화(1/1)로 본다.
 */
export function computeTurns(rows: QueryLogExportItem[]): Map<number, TurnInfo> {
  const bySession = new Map<string, QueryLogExportItem[]>();
  for (const r of rows) {
    const key = r.session_id ?? `__solo__${r.id}`;
    const g = bySession.get(key);
    if (g) g.push(r);
    else bySession.set(key, [r]);
  }

  const out = new Map<number, TurnInfo>();
  for (const group of bySession.values()) {
    const ordered = [...group].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id - b.id,
    );
    ordered.forEach((r, i) => {
      // message_count = 클라이언트가 보낸 히스토리 길이(1, 3, 5 …) → 회차 = ⌈mc/2⌉.
      const fromCount =
        r.message_count != null && r.message_count > 0
          ? Math.ceil(r.message_count / 2)
          : null;
      out.set(r.id, { turn: fromCount ?? i + 1, sessionTurns: ordered.length });
    });
  }
  return out;
}

type Column = {
  header: string;
  width: number;
  wrap?: boolean;
  value: (r: QueryLogExportItem, t: TurnInfo) => string | number | null;
};

const COLUMNS: Column[] = [
  { header: "번호", width: 8, value: (r) => r.id },
  { header: "일시(KST)", width: 19, value: (r) => fmtKst(r.created_at) },
  { header: "IP", width: 15, value: (r) => r.ip ?? "" },
  { header: "대화ID", width: 38, value: (r) => r.session_id ?? "" },
  { header: "대화 회차", width: 9, value: (_r, t) => t.turn },
  { header: "대화 질의수", width: 11, value: (_r, t) => t.sessionTurns },
  { header: "멀티턴", width: 8, value: (_r, t) => (t.sessionTurns > 1 ? "Y" : "N") },
  { header: "분기", width: 9, value: (r) => (r.route ? ROUTE_LABEL[r.route] ?? r.route : "미분류") },
  { header: "질문", width: 60, wrap: true, value: (r) => clip(r.query) },
  { header: "답변", width: 90, wrap: true, value: (r) => clip(r.answer) },
  { header: "최고 관련도", width: 11, value: (r) => r.top_score },
  { header: "환각", width: 7, value: (r) => (r.has_hallucination ? "Y" : "") },
  { header: "인용 수", width: 8, value: (r) => r.citation_count },
  { header: "인용 검증", width: 9, value: (r) => r.citation_verified_count },
  { header: "평가", width: 8, value: (r) => feedbackLabel(r.feedback) },
  { header: "첫토큰(ms)", width: 11, value: (r) => r.ttft_ms },
  { header: "총소요(ms)", width: 11, value: (r) => r.total_ms },
  { header: "입력토큰", width: 10, value: (r) => r.tokens_in },
  { header: "출력토큰", width: 10, value: (r) => r.tokens_out },
  { header: "오류코드", width: 14, value: (r) => r.error_code ?? "" },
];

/** 조회조건 시트에 적을 필터 요약(사람이 읽는 라벨). */
function filterSummary(filter: QueryLogFilter): [string, string][] {
  return [
    // since/until 은 대시보드가 만든 원문 그대로 적는다(KST 환산 표기는 오히려 오해 소지).
    ["시작(since)", filter.since ?? "제한 없음"],
    ["종료(until)", filter.until ?? "제한 없음"],
    ["분기", filter.route ? ROUTE_LABEL[filter.route] ?? filter.route : "전체"],
    ["검색어", filter.search ?? ""],
    ["IP", filter.ip ?? ""],
    ["환각만", filter.hallucinationOnly ? "Y" : "N"],
    ["부정평가만", filter.negativeOnly ? "Y" : "N"],
    ["정렬", `${filter.sort ?? "created_at"} ${filter.sortDir ?? "desc"}`],
  ];
}

/** 쿼리로그 행 → xlsx 버퍼. 시트 2장(쿼리로그 · 조회조건). */
export async function buildQueryLogWorkbook(
  rows: QueryLogExportItem[],
  filter: QueryLogFilter,
  truncated: boolean,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "PIMS";
  wb.created = new Date();

  const ws = wb.addWorksheet("쿼리로그", {
    views: [{ state: "frozen", ySplit: 1 }], // 머리행 고정
  });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width }));

  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F4A6D" } };
  head.alignment = { vertical: "middle" };
  head.height = 20;

  const turns = computeTurns(rows);
  const solo: TurnInfo = { turn: 1, sessionTurns: 1 };
  for (const r of rows) {
    const t = turns.get(r.id) ?? solo;
    ws.addRow(COLUMNS.map((c) => c.value(r, t)));
  }

  // 질문·답변만 줄바꿈 표시(나머지는 한 줄 유지 — 행 높이가 튀지 않게).
  COLUMNS.forEach((c, i) => {
    if (c.wrap) ws.getColumn(i + 1).alignment = { wrapText: true, vertical: "top" };
  });
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  }

  const meta = wb.addWorksheet("조회조건");
  meta.columns = [{ width: 18 }, { width: 60 }];
  meta.addRow(["내보낸 시각(KST)", fmtKst(new Date().toISOString())]);
  meta.addRow(["행 수", rows.length]);
  for (const [k, v] of filterSummary(filter)) meta.addRow([k, v]);
  meta.addRow([
    "대화 회차",
    "같은 대화(대화ID)의 몇 번째 질문인지. 대화 질의수는 이번 내보내기 범위 안에서 센 값.",
  ]);
  if (truncated) {
    const row = meta.addRow(["⚠ 상한 도달", "내보내기 상한(50,000행)에 걸려 일부만 담겼습니다."]);
    row.font = { bold: true, color: { argb: "FFB00020" } };
  }
  meta.getColumn(1).font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
