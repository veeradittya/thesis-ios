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
    // Pin the JWT subject to the STABLE Google account id (`profile.sub`). Without this, Auth.js v5
    // (JWT strategy, no DB adapter) mints a fresh random UUID for `token.sub` on every new
    // session/device, so the same Google account would fragment into many "users" — one per sign-in.
    // `profile` is only present on the initial sign-in; afterwards the pinned value rides in the JWT.
    jwt({ token, profile }) {
      if (profile?.sub) token.sub = String(profile.sub);
      return token;
    },
    // Surface that same stable per-account id on the client session so every write (holdings,
    // activity, device, brief) and the sign-in record all key off one id.
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
