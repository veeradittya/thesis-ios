"use client";

import { useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";

// The two login options, presented with EQUAL prominence — Apple App Store Guideline 4.8 +
// Apple's HIG require "Sign in with Apple" to sit alongside other social logins, same size,
// not hidden or below the fold. Both are full-width, same height, dark-theme brand variants
// so they read as peers on the app's near-black background.
//
// Both buttons route to the NATIVE sign-in sheet when running inside the iOS shell (Google: a smooth
// one-tap picker sharing the device's Google session; Apple: the system Apple sheet, since Apple's web
// flow is unreliable in the WKWebView), and fall back to web OAuth everywhere else (desktop / mobile
// web). No native code lives here — only the postMessage handoff.
function continueWithGoogle(callbackUrl: string) {
  const handler = (
    window as unknown as {
      webkit?: { messageHandlers?: { thesisGoogleSignIn?: { postMessage: (m: unknown) => void } } };
    }
  ).webkit?.messageHandlers?.thesisGoogleSignIn;
  // Inside the native shell: ask it to run GIDSignIn. It calls window.__thesisNativeGoogleSignIn(idToken)
  // back (see NativeGoogleSignIn.tsx) to complete the session. Elsewhere: standard web OAuth.
  if (handler) {
    handler.postMessage({});
    return;
  }
  signIn("google", { callbackUrl });
}

function continueWithApple(callbackUrl: string) {
  const handler = (
    window as unknown as {
      webkit?: { messageHandlers?: { thesisAppleSignIn?: { postMessage: (m: unknown) => void } } };
    }
  ).webkit?.messageHandlers?.thesisAppleSignIn;
  // Inside the native shell: ask it to present the system Apple sheet. It calls
  // window.__thesisNativeAppleSignIn(payload) back (see NativeAppleSignIn.tsx). Elsewhere: web OAuth.
  if (handler) {
    handler.postMessage({});
    return;
  }
  signIn("apple", { callbackUrl });
}

export function SignInButtons({ callbackUrl = "/", onOverride }: { callbackUrl?: string; onOverride?: () => void }) {
  // onOverride (when passed) replaces the real Google/Apple sign-in on BOTH buttons — used by the local
  // onboarding preview to skip auth and jump to the next step. Without it, the normal sign-in flows run.
  const onGoogle = onOverride ?? (() => continueWithGoogle(callbackUrl));
  const onApple = onOverride ?? (() => continueWithApple(callbackUrl));

  // Beta-code sign-in. Always the REAL flow (never overridden): a valid code mints a session for the
  // stable beta account, then a full reload lets the app run onboarding (new code) or restore the
  // account's portfolio (existing code). Invalid codes surface an inline error.
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const submitBeta = async (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (!c || busy) return;
    setBusy(true);
    setError(false);
    try {
      const res = await signIn("beta-code", { code: c, redirect: false });
      if (res?.ok && !res.error) {
        window.location.assign(callbackUrl || "/");
        return;
      }
    } catch {
      /* fall through to the error state */
    }
    setError(true);
    setBusy(false);
  };

  return (
    <div className="flex w-full max-w-[320px] flex-col gap-3">
      <button
        onClick={onGoogle}
        className="inline-flex h-12 w-full items-center justify-center gap-2.5 rounded-full border border-white/15 bg-[#131314] text-[16px] font-medium text-white transition-colors hover:bg-[#1d1d1f]"
      >
        <GoogleLogo className="h-[18px] w-[18px]" />
        Continue with Google
      </button>
      <button
        onClick={onApple}
        className="inline-flex h-12 w-full items-center justify-center gap-2.5 rounded-full border border-white/15 bg-black text-[16px] font-medium text-white transition-colors hover:bg-[#111]"
      >
        <AppleLogo className="h-[19px] w-[19px]" />
        Continue with Apple
      </button>

      {/* divider */}
      <div className="flex items-center gap-3 py-0.5">
        <span className="h-px flex-1 bg-white/10" />
        <span className="text-[11px] uppercase tracking-wider text-white/35">or</span>
        <span className="h-px flex-1 bg-white/10" />
      </div>

      {/* Beta-code field — same pill footprint as the buttons, with an inline submit. */}
      <form onSubmit={submitBeta} className="flex flex-col gap-2">
        <div className="relative">
          <input
            value={code}
            onChange={(e) => { setCode(e.target.value); if (error) setError(false); }}
            placeholder="Sign up with beta code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Beta code"
            className={`h-12 w-full rounded-full border bg-black pl-5 pr-[104px] text-[15px] text-white outline-none transition-colors placeholder:text-white/40 ${error ? "border-rose-500/50" : "border-white/15 focus:border-white/30"}`}
          />
          <button
            type="submit"
            disabled={!code.trim() || busy}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center rounded-full bg-white/10 px-4 py-2 text-[13px] font-medium text-white transition-colors enabled:hover:bg-white/20 disabled:opacity-40"
          >
            {busy ? "Checking…" : "Continue"}
          </button>
        </div>
        {error && <p className="px-1 text-center text-[13px] text-rose-300">That beta code isn’t valid.</p>}
      </form>
    </div>
  );
}

// Apple mark (single glyph, inherits currentColor → white here).
function AppleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M17.05 12.04c-.03-2.7 2.2-3.99 2.3-4.05-1.25-1.83-3.2-2.08-3.9-2.11-1.66-.17-3.24.98-4.08.98-.84 0-2.14-.96-3.52-.93-1.81.03-3.48 1.05-4.41 2.67-1.88 3.27-.48 8.11 1.35 10.77.89 1.3 1.95 2.76 3.35 2.71 1.34-.05 1.85-.87 3.47-.87 1.62 0 2.08.87 3.5.84 1.44-.03 2.36-1.32 3.24-2.63 1.02-1.5 1.44-2.96 1.46-3.03-.03-.01-2.8-1.08-2.83-4.27zM14.53 4.6c.74-.9 1.24-2.15 1.1-3.4-1.07.04-2.36.71-3.12 1.61-.68.79-1.28 2.06-1.12 3.28 1.19.09 2.4-.6 3.14-1.49z" />
    </svg>
  );
}

// Google four-colour "G".
function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={className}>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
