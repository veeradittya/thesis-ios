import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Apple from "next-auth/providers/apple";
import Credentials from "next-auth/providers/credentials";
import { verifyGoogleIdToken } from "@/lib/googleVerify";
import { verifyAppleIdentityToken } from "@/lib/appleVerify";
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
  providers: [
    Google,
    Apple,
    // Native iOS Google Sign-In (smooth one-tap account picker). The native shell runs GIDSignIn,
    // gets a Google ID token, and hands it to the WKWebView, which calls signIn("google-native",
    // { idToken }). We verify the token server-side and mint OUR session cookie in the webview. The
    // returned `id` is the Google `sub` — identical to web Google sign-in, so it is ONE identity.
    // Invoked only via the token bridge; not shown as a button.
    Credentials({
      id: "google-native",
      name: "Google (native iOS)",
      credentials: { idToken: { label: "Google ID token", type: "text" } },
      async authorize(creds) {
        const idToken = typeof creds?.idToken === "string" ? creds.idToken : "";
        const id = await verifyGoogleIdToken(idToken);
        if (!id?.sub) return null;
        return { id: id.sub, email: id.email ?? undefined, name: id.name ?? undefined, image: id.picture ?? undefined };
      },
    }),
    // Native iOS Sign in with Apple (Apple's web flow is unreliable inside the WKWebView). The native
    // shell presents the system Apple sheet and calls signIn("apple-native", { identityToken, nonce,
    // email?, name? }) — email/name only on the user's FIRST authorization. We verify the identity
    // token against Apple's public keys + the raw nonce, then mint OUR session cookie in the webview.
    // The returned `id` is Apple's stable `sub` — identical to the web "apple" provider, so native +
    // web Apple are ONE identity (a distinct namespace from Google). Invoked only via the bridge.
    Credentials({
      id: "apple-native",
      name: "Apple (native iOS)",
      credentials: { identityToken: {}, nonce: {}, email: {}, name: {} },
      async authorize(creds) {
        const identityToken = typeof creds?.identityToken === "string" ? creds.identityToken : "";
        const nonce = typeof creds?.nonce === "string" ? creds.nonce : "";
        const id = await verifyAppleIdentityToken(identityToken, nonce);
        if (!id?.sub) return null;
        // Apple returns email/name only on the first authorization and the token may omit email — fall
        // back to what native forwarded from that first consent so the users table can be populated.
        const email = id.email ?? (typeof creds?.email === "string" ? creds.email : undefined);
        const name = typeof creds?.name === "string" ? creds.name : undefined;
        return { id: id.sub, email: email ?? undefined, name };
      },
    }),
  ],
  session: { strategy: "jwt" },
  trustHost: true, // self-hosted (localhost and any non-Vercel host)
  callbacks: {
    // Pin the JWT subject to the STABLE Google account id (`profile.sub`). Without this, Auth.js v5
    // (JWT strategy, no DB adapter) mints a fresh random UUID for `token.sub` on every new
    // session/device, so the same Google account would fragment into many "users" — one per sign-in.
    // `profile` is only present on the initial sign-in; afterwards the pinned value rides in the JWT.
    async jwt({ token, profile, user }) {
      if (profile?.sub) {
        token.sub = String(profile.sub);
        return token;
      }
      // Native Credentials sign-ins (`google-native` / `apple-native`) have no OAuth `profile`, but
      // `user.id` is the verified provider `sub` — pin it so the session is the SAME identity as the
      // matching web flow (Google sub for google-native, Apple sub for apple-native). (`user` is only
      // present on the initial sign-in call.)
      if (user?.id) {
        token.sub = String(user.id);
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
