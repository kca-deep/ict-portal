"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// 관리자 로그인 폼. 아이디+비밀번호를 /api/admin/login 에 보내고, 성공하면 서명
// 쿠키가 발급되므로 /admin 으로 이동한다. 실패하면 어느 필드가 틀렸는지 드러내지
// 않는 동일한 일반 오류만 노출한다.
//
// 테마는 admin_advisor_console_proposal.html 시안의 "시안/틸 콘솔 룩"을 이 페이지에만
// 스코프로 적용한다(.login-console 하위에서만 유효). 전역 토큰(globals.css)은 건드리지
// 않으므로 대시보드 테마와 분리된다. 본문 폰트는 전역 IBM Plex Sans KR 을 상속하고,
// 모노 라벨은 기존 --font-mono 토큰(JetBrains Mono → 시스템 모노 폴백)을 쓴다.
export default function AdminLoginPage() {
  const [username, setUsername] = useState("");
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
        body: JSON.stringify({ username, password }),
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

  const disabled = loading || username.length === 0 || password.length === 0;

  return (
    <main className="login-console">
      <style>{`
        .login-console {
          --paper:#eef1f4; --surface:#ffffff; --input:#f1f4f7;
          --border:#dde3ea; --border-bright:#c6d0da;
          --text:#0f1922; --text-2:#53616e; --text-muted:#7d8b98; --text-dim:#a9b4bf;
          --cyan:#0a94ab; --cyan-soft:#077f94; --cyan-dim:rgba(10,148,171,0.10);
          --critical:#d93a3a;
          --shadow-md:0 4px 14px -6px rgba(15,25,34,0.14), 0 1px 3px rgba(15,25,34,0.05);
          --mono:var(--font-mono, "JetBrains Mono", ui-monospace, monospace);
          position:relative;
          display:flex; align-items:center; justify-content:center;
          min-height:100vh; padding:24px;
          background:var(--paper);
          background-image:
            radial-gradient(circle at 8% 0%, rgba(10,148,171,0.055), transparent 34%),
            radial-gradient(circle at 94% 100%, rgba(183,121,31,0.04), transparent 42%);
          color:var(--text);
        }
        .login-console::before {
          content:""; position:absolute; inset:0; z-index:0; pointer-events:none;
          background-image:
            linear-gradient(rgba(15,25,34,0.028) 1px, transparent 1px),
            linear-gradient(90deg, rgba(15,25,34,0.028) 1px, transparent 1px);
          background-size:52px 52px;
        }
        .lc-card {
          position:relative; z-index:1;
          width:100%; max-width:380px;
          background:var(--surface); border:1px solid var(--border);
          border-radius:6px; box-shadow:var(--shadow-md); padding:32px;
        }
        .lc-brand { display:flex; align-items:center; gap:13px; margin-bottom:26px; }
        .lc-mark {
          width:42px; height:42px; flex-shrink:0; border-radius:11px;
          background:linear-gradient(140deg, var(--cyan), var(--cyan-soft));
          display:grid; place-items:center;
          color:#fff; font-weight:700; font-size:17px; letter-spacing:-0.02em;
          box-shadow:0 3px 11px -3px rgba(10,148,171,0.6);
        }
        .lc-name { font-weight:700; font-size:19px; letter-spacing:-0.02em; color:var(--text); }
        .lc-name .lc-accent { color:var(--cyan-soft); }
        .lc-sub {
          margin-top:4px; font-family:var(--mono); font-size:10px;
          letter-spacing:0.05em; text-transform:uppercase; color:var(--text-muted);
        }
        .lc-field { margin-top:16px; }
        .lc-label {
          display:block; margin-bottom:6px;
          font-family:var(--mono); font-size:10.5px; font-weight:500;
          letter-spacing:0.08em; text-transform:uppercase; color:var(--text-muted);
        }
        .lc-input {
          width:100%; background:var(--input); border:1px solid var(--border);
          border-radius:6px; padding:10px 12px; font-size:13.5px; color:var(--text);
          outline:none; transition:border-color .15s;
        }
        .lc-input::placeholder { color:var(--text-dim); }
        .lc-input:focus { border-color:var(--cyan); }
        .lc-error { margin-top:14px; font-size:12.5px; color:var(--critical); }
        .lc-btn {
          margin-top:24px; width:100%; border:none; cursor:pointer;
          background:var(--cyan); color:#fff;
          border-radius:6px; padding:11px; font-size:13.5px; font-weight:600;
          letter-spacing:0.01em; transition:background .15s;
        }
        .lc-btn:hover:not(:disabled) { background:var(--cyan-soft); }
        .lc-btn:disabled { opacity:.4; cursor:not-allowed; }
        @media (prefers-reduced-motion:reduce) { .lc-input, .lc-btn { transition:none; } }
      `}</style>

      <form onSubmit={onSubmit} className="lc-card">
        <div className="lc-brand">
          <div className="lc-mark">P</div>
          <div>
            <div className="lc-name">
              PIMS <span className="lc-accent">Advisor</span>
            </div>
            <div className="lc-sub">규정·법령 어드바이저 · 운영 콘솔</div>
          </div>
        </div>

        <div className="lc-field">
          <label htmlFor="admin-username" className="lc-label">
            아이디
          </label>
          <input
            id="admin-username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            // autoFocus 된 입력칸에 브라우저 도구/확장(cmux 등)이 focus 속성을
            // 주입해 하이드레이션 mismatch 를 유발할 수 있다. 서드파티 DOM 변경이
            // 원인이므로 이 요소에 한해 경고를 억제한다(실사용자엔 무영향).
            suppressHydrationWarning
            className="lc-input"
          />
        </div>

        <div className="lc-field">
          <label htmlFor="admin-password" className="lc-label">
            비밀번호
          </label>
          <input
            id="admin-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="lc-input"
          />
        </div>

        {error && (
          <p className="lc-error">아이디 또는 비밀번호가 올바르지 않습니다.</p>
        )}

        <button type="submit" disabled={disabled} className="lc-btn">
          {loading ? "확인 중…" : "로그인"}
        </button>
      </form>
    </main>
  );
}
