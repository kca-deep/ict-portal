"use client";

import { useState } from "react";

// 로그아웃 버튼 — 세션 쿠키를 지우고 새로고침하면 미들웨어가 로그인 폼으로 보낸다
// (슬러그/legacy 어느 경로에서든 현재 경로 기준으로 동작하므로 base 계산이 필요 없다).
export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  async function onLogout() {
    setBusy(true);
    try {
      await fetch("/api/admin/logout", { method: "POST" });
    } finally {
      window.location.reload();
    }
  }
  return (
    <button
      onClick={onLogout}
      disabled={busy}
      className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
    >
      로그아웃
    </button>
  );
}
