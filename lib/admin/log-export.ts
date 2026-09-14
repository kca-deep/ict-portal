import ExcelJS from "exceljs";
import type { QueryLogExportItem, QueryLogFilter } from "@/lib/db/query-log";

// 쿼리로그 엑셀(.xlsx) 생성. 관리자 대시보드의 "엑셀 다운로드" 가 현재 필터 그대로
// 호출한다(표에 보이는 모집단 = 파일에 담기는 모집단).
//
// 멀티턴 대화: query_log 는 "요청 1건 = 1행"이라 같은 대화(session_id)가 여러 행으로
// 흩어진다. 행마다 그 대화에서 주고받은 질의응답 총 수(대화 질의수)를 넣는다. 질의수는
// 내보내기 필터·기간과 무관한 대화 전체 기준이다(countQueriesBySession). 대화ID 가 없는
// 옛 행은 단독 질의(1)로 본다.

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

type Column = {
  header: string;
  width: number;
  wrap?: boolean;
  /** n = 이 행이 속한 대화의 질의수. */
  value: (r: QueryLogExportItem, n: number) => string | number | null;
};

const COLUMNS: Column[] = [
  { header: "번호", width: 8, value: (r) => r.id },
  { header: "일시(KST)", width: 19, value: (r) => fmtKst(r.created_at) },
  { header: "IP", width: 15, value: (r) => r.ip ?? "" },
  { header: "대화ID", width: 38, value: (r) => r.session_id ?? "" },
  { header: "대화 질의수", width: 11, value: (_r, n) => n },
  { header: "멀티턴", width: 8, value: (_r, n) => (n > 1 ? "Y" : "N") },
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
  sessionQueries: Map<string, number>,
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

  for (const r of rows) {
    const n = (r.session_id && sessionQueries.get(r.session_id)) || 1;
    ws.addRow(COLUMNS.map((c) => c.value(r, n)));
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
    "대화 질의수",
    "같은 대화(대화ID)에서 주고받은 질의응답 총 수. 필터·기간과 무관한 대화 전체 기준.",
  ]);
  if (truncated) {
    const row = meta.addRow(["⚠ 상한 도달", "내보내기 상한(50,000행)에 걸려 일부만 담겼습니다."]);
    row.font = { bold: true, color: { argb: "FFB00020" } };
  }
  meta.getColumn(1).font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
