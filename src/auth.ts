import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Apple from "next-auth/providers/apple";
import { recordSignIn, logActivity, getCanonicalUserId } from "@/lib/turso";

// Auth.js (NextAuth v5) — Google + Apple sign-in with stateless JWT sessions (no DB yet).
// Google auto-reads AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET; Apple auto-reads AUTH_APPLE_ID (the
// Sign in with Apple **Services ID**, NOT the app bundle id) and AUTH_APPLE_SECRET (an ES256
// client-secret JWT that EXPIRES in <=6 months — see PR notes for how to mint/renew it).
// AUTH_SECRET signs the session cookie. Apple uses response_mode=form_post, so its callback is
// a POST to /api/auth/callback/apple — the default Auth.js handlers accept it. If the Apple env
// is unset the provider is registered but only errors when its button is used; Google is unaffected.
// See .env.local / .env.production.example for the values + provider setup steps.
export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [Google, Apple],
  session: { strategy: "jwt" },
  trustHost: true, // self-hosted (localhost and any non-Vercel host)
  callbacks: {
    // Pin the JWT subject to the STABLE Google account id (`profile.sub`). Without this, Auth.js v5
    // (JWT strategy, no DB adapter) mints a fresh random UUID for `token.sub` on every new
    // session/device, so the same Google account would fragment into many "users" — one per sign-in.
    // `profile` is only present on the initial sign-in; afterwards the pinned value rides in the JWT.
    async jwt({ token, profile }) {
      if (profile?.sub) {
        token.sub = String(profile.sub);
        return token;
      }
      // Self-heal LEGACY sessions minted before this fix: their token.sub is a random v4 UUID (not a
      // numeric Google sub). Resolve the stable id from the DB by email, once — this callback runs
      // whenever the session is accessed, and the updated token is re-issued to the cookie, so the
      // lookup stops as soon as the id is healed. No re-login needed.
      // Match ONLY the UUID shape: an Apple sub (e.g. "001809.<hex>.0918") is also non-numeric but is a
      // valid stable id in its own namespace — it must NOT be rewritten to a Google id by an email
      // match (Apple and Google identities stay distinct for launch — see the providers note above),
      // and matching it here would also re-query Turso on every authenticated request.
      const isLegacyUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(token.sub ?? ""));
      if (token.sub && token.email && isLegacyUuid) {
        try {
          const canonical = await getCanonicalUserId(token.email as string);
          if (canonical) token.sub = canonical;
        } catch {
          /* keep the existing id if the lookup fails; never block auth */
        }
      }
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
