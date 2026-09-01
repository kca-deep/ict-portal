import { NextRequest, NextResponse } from "next/server";
import { adminCookieName, adminSessionSecret, verifySession } from "@/lib/admin-auth";
import { listQueryLogsForExport } from "@/lib/db/query-log";
import { parseLogFilter } from "@/lib/admin/log-filter";
import { buildQueryLogWorkbook } from "@/lib/admin/log-export";

// 쿼리로그 엑셀(.xlsx) 다운로드. 대시보드가 현재 필터를 그대로 붙여 호출하므로
// 표에 보이는 모집단이 파일에 담긴다(페이징만 없음 — 전 범위, 상한 50,000행).
// 목록 API 와 같은 이유로 여기서 관리자 세션 쿠키를 직접 검증한다(service_role 조회).
export const runtime = "nodejs";
// 대량 조회 + 워크북 직렬화. 기본 타임아웃으로는 큰 범위에서 잘릴 수 있어 넉넉히 잡는다.
export const maxDuration = 120;

// 파일명은 KST 시각 도장. 한글명(filename*)과 ASCII 폴백(filename)을 함께 만든다.
function fileNames(): { name: string; ascii: string } {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${kst.getUTCFullYear()}${p(kst.getUTCMonth() + 1)}${p(kst.getUTCDate())}` +
    `_${p(kst.getUTCHours())}${p(kst.getUTCMinutes())}`;
  return { name: `PIMS_쿼리로그_${stamp}.xlsx`, ascii: `pims-query-log-${stamp}.xlsx` };
}

export async function GET(req: NextRequest) {
  const secret = adminSessionSecret();
  const token = req.cookies.get(adminCookieName())?.value;
  const authed = !!secret && !!token && (await verifySession(token, secret));
  if (!authed) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const filter = parseLogFilter(req.nextUrl.searchParams);

  try {
    const { rows, truncated } = await listQueryLogsForExport(filter);
    const buf = await buildQueryLogWorkbook(rows, filter, truncated);
    // 파일명이 한글이라 ASCII 폴백(filename)과 RFC 5987(filename*)을 함께 보낸다.
    const { name, ascii } = fileNames();
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    console.error("[admin/logs/export] failed:", (err as Error).message);
    return NextResponse.json({ error: "export failed" }, { status: 500 });
  }
}
