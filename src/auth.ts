import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { recordSignIn, logActivity } from "@/lib/turso";

// Auth.js (NextAuth v5) — Google sign-in with stateless JWT sessions (no DB yet).
// The Google provider auto-reads AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET; AUTH_SECRET signs
// the session cookie. See .env.local for the values + the Google Cloud setup steps.
export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  trustHost: true, // self-hosted (localhost and any non-Vercel host)
  callbacks: {
    // Surface a stable per-account id (the Google `sub`) on the client session so the
    // dashboard can namespace this user's cached ledger/layout/cards.
    session({ session, token }) {
      if (token.sub && session.user) session.user.id = token.sub;
      return session;
    },
  },
  events: {
    // On every sign-in, record the user's identity + tenure in Turso (first_seen once, last_seen
    // and count each time). Keyed by the Google `sub` so it matches session.user.id everywhere.
    // Best-effort — never block sign-in if the write fails.
    async signIn({ user, profile }) {
      const userId = (profile as { sub?: string } | undefined)?.sub ?? user?.id;
      if (!userId) return;
      try {
        await recordSignIn(userId, user?.email ?? null, user?.name ?? null);
        await logActivity(userId, "sign_in", user?.email ?? null);
      } catch {
        /* don't block sign-in on a logging failure */
      }
    },
  },
});
