// 관리자 대시보드(쿼리로그 뷰어). 미들웨어(/admin 게이트)가 서명 쿠키를 통과시킨
// 요청만 여기에 도달한다. 이 단계에서는 접근 제어가 동작하는지 확인하는 빈 껍데기다 —
// 요약·로그 표·상세는 5단계에서 채운다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function AdminPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-xl font-semibold text-neutral-900">관리자 대시보드</h1>
      <p className="mt-2 text-sm text-neutral-600">
        로그인에 성공했습니다. 쿼리로그 뷰어는 곧 이 화면에 표시됩니다.
      </p>
    </main>
  );
}
