"use client";

import { useEffect } from "react";
import { signIn } from "next-auth/react";

// Bridge to the native iOS shell's Sign in with Apple. Apple's web OAuth is unreliable inside the
// WKWebView, so the native shell presents the system Apple sheet and calls
//   window.__thesisNativeAppleSignIn({ identityToken, nonce, email?, name? })  ->  Promise<boolean>
// (email/name are present ONLY on the user's first authorization). We hand it to Auth.js
// ("apple-native" Credentials provider), which verifies the identity token + nonce server-side and
// sets our session cookie IN THIS WKWebView. Resolves true on success (then reloads so the UI reflects
// the session); false on failure so the native side can surface an error / retry. Renders nothing.

type ApplePayload = { identityToken: string; nonce: string; email?: string; name?: string };

export function NativeAppleSignIn() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as { __thesisNativeAppleSignIn?: (p: ApplePayload) => Promise<boolean> };
    w.__thesisNativeAppleSignIn = async (payload: ApplePayload) => {
      if (!payload?.identityToken || !payload?.nonce) return false;
      try {
        const res = await signIn("apple-native", { ...payload, redirect: false });
        if (res?.ok && !res.error) {
          window.location.reload(); // pick up the freshly-set session cookie
          return true;
        }
      } catch {
        /* fall through to false — native side can surface an error / retry */
      }
      return false;
    };
    return () => {
      try {
        delete w.__thesisNativeAppleSignIn;
      } catch {
        /* ignore */
      }
    };
  }, []);

  return null;
}
