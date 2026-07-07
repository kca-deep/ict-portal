"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// 관리자 로그인 폼. 비밀번호를 /api/admin/login 에 보내고, 성공하면 서명 쿠키가
// 발급되므로 /admin 으로 이동한다. 실패하면 동일한 일반 오류만 노출한다.
export default function AdminLoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.replace("/admin");
        router.refresh();
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-8 shadow-sm"
      >
        <h1 className="text-lg font-semibold text-neutral-900">관리자 로그인</h1>
        <p className="mt-1 text-sm text-neutral-500">
          쿼리로그 대시보드에 접근하려면 비밀번호를 입력하세요.
        </p>

        <label htmlFor="admin-password" className="mt-6 block text-sm font-medium text-neutral-700">
          비밀번호
        </label>
        <input
          id="admin-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          autoFocus
          className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
        />

        {error && (
          <p className="mt-3 text-sm text-red-600">
            비밀번호가 올바르지 않습니다.
          </p>
        )}

        <button
          type="submit"
          disabled={loading || password.length === 0}
          className="mt-6 w-full rounded-lg bg-neutral-900 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40"
        >
          {loading ? "확인 중…" : "로그인"}
        </button>
      </form>
    </main>
  );
}
