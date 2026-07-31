"use client";

import { useEffect } from "react";
import { signIn } from "next-auth/react";

// Bridge to the native iOS shell's Google Sign-In SDK. After GIDSignIn completes natively (the smooth
// one-tap account picker that shares the device's Google session), iOS calls
//   window.__thesisNativeGoogleSignIn(idToken)  ->  Promise<boolean>
// with the Google ID token. We hand it to Auth.js ("google-native" Credentials provider), which
// verifies it server-side and sets our session cookie IN THIS WKWebView — logging the web app in with
// nothing typed. Resolves true on success (then reloads so the UI reflects the session). Renders nothing.
export function NativeGoogleSignIn() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as { __thesisNativeGoogleSignIn?: (idToken: string) => Promise<boolean> };
    w.__thesisNativeGoogleSignIn = async (idToken: string) => {
      if (!idToken) return false;
      try {
        const res = await signIn("google-native", { idToken, redirect: false });
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
        delete w.__thesisNativeGoogleSignIn;
      } catch {
        /* ignore */
      }
    };
  }, []);

  return null;
}
