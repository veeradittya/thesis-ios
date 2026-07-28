"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";

// Bridge to the native iOS shell (WKWebView). Once iOS has an APNs device token it calls
//   window.__thesisRegisterPushToken(token, 'ios')
// on every load. We define that global and POST the token to /api/push/register. A token can arrive
// before the user is signed in (→ 401); we stash the last token and re-POST after authentication.
// Renders nothing.

const LS_KEY = "thesis.pushToken.v1";

async function postToken(token: string, platform: string) {
  try {
    await fetch("/api/push/register", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, platform }),
    });
  } catch {
    /* best-effort; retried on next load / after sign-in */
  }
}

export function PushRegistration() {
  const { status } = useSession();

  // Expose the global the native shell calls.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as { __thesisRegisterPushToken?: (t: string, p?: string) => void };
    w.__thesisRegisterPushToken = (token: string, platform = "ios") => {
      if (!token) return;
      try { localStorage.setItem(LS_KEY, JSON.stringify({ token, platform })); } catch {}
      postToken(token, platform); // 401 if not signed in yet — re-sent by the effect below on login
    };
    return () => { try { delete w.__thesisRegisterPushToken; } catch {} };
  }, []);

  // After sign-in, re-send the last token we saw (it may have been captured — and 401'd — pre-login).
  useEffect(() => {
    if (status !== "authenticated" || typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const { token, platform } = JSON.parse(raw) as { token?: string; platform?: string };
      if (token) postToken(token, platform || "ios");
    } catch {
      /* ignore */
    }
  }, [status]);

  return null;
}
