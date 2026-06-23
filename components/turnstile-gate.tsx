"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/api.js?render=explicit";

// Cloudflare 가 주입하는 전역. 타입 최소 선언.
type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      size?: "invisible" | "normal" | "flexible";
      callback?: (token: string) => void;
      "error-callback"?: () => void;
    },
  ) => string;
  execute: (id: string) => void;
  reset: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/**
 * Invisible Turnstile 훅(골격).
 * - site key 부재 시: Widget=null, getToken()→null. 호출부는 토큰 없이 기존대로 전송.
 * - site key 존재 시: 보이지 않는 위젯을 렌더하고, getToken()이 execute→callback 토큰을 해결.
 *   토큰은 1회용이므로 매 전송 시 reset 후 새로 발급.
 */
export function useTurnstileToken() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const resolverRef = useRef<((t: string | null) => void) | null>(null);
  const [ready, setReady] = useState(!SITE_KEY); // 키 없으면 처음부터 준비완료(무게이트)

  useEffect(() => {
    if (!SITE_KEY || !containerRef.current) return;

    function renderWidget() {
      if (!window.turnstile || !containerRef.current || widgetIdRef.current)
        return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: SITE_KEY!,
        size: "invisible",
        callback: (token: string) => resolverRef.current?.(token),
        "error-callback": () => resolverRef.current?.(null),
      });
      setReady(true);
    }

    if (window.turnstile) {
      renderWidget();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`,
    );
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.setAttribute("src", SCRIPT_SRC);
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", renderWidget);
    return () => script.removeEventListener("load", renderWidget);
  }, []);

  const getToken = useCallback((): Promise<string | null> => {
    if (!SITE_KEY) return Promise.resolve(null); // 무게이트
    const api = window.turnstile;
    const id = widgetIdRef.current;
    if (!api || !id) return Promise.resolve(null);
    return new Promise((resolve) => {
      resolverRef.current = (t) => {
        resolverRef.current = null;
        api.reset(id); // 다음 전송용으로 초기화
        resolve(t);
      };
      api.execute(id);
    });
  }, []);

  const Widget = useCallback(
    () => (SITE_KEY ? <div ref={containerRef} className="hidden" /> : null),
    [],
  );

  return { ready, getToken, Widget };
}
