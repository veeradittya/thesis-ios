import { createRemoteJWKSet, jwtVerify } from "jose";

// Verify a Sign in with Apple IDENTITY TOKEN minted NATIVELY (ASAuthorization) against Apple's public
// keys, then bind it to the client-supplied raw nonce. Mirrors src/lib/googleVerify.ts. Apple has no
// tokeninfo endpoint, so we verify the JWT signature locally via Apple's JWKS (fetched + cached by
// jose). Edge-safe: jose + Web Crypto only, no node:crypto.
//
// Nonce: the native side requests Apple sign-in with nonce = SHA-256(rawNonce) and forwards us the RAW
// nonce; Apple echoes the hashed value into the token's `nonce` claim. We recompute SHA-256(rawNonce)
// and require it to equal token.nonce — tying the token to THIS sign-in attempt (replay defense).

export type AppleIdentity = { sub: string; email: string | null };

const APPLE_JWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
// For NATIVE identity tokens `aud` is the app's BUNDLE ID (not the web Services ID). Defaults to the
// shipped bundle id; override per-env with APPLE_NATIVE_AUD.
const APPLE_NATIVE_AUD = process.env.APPLE_NATIVE_AUD || "com.betathesis.app";

async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyAppleIdentityToken(identityToken: string, rawNonce: string): Promise<AppleIdentity | null> {
  if (!identityToken || !rawNonce) return null;

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(identityToken, APPLE_JWKS, {
      issuer: "https://appleid.apple.com",
      audience: APPLE_NATIVE_AUD,
    })); // throws on bad signature / wrong iss|aud / expiry
  } catch {
    return null;
  }

  const tokenNonce = typeof payload.nonce === "string" ? payload.nonce : "";
  if (!tokenNonce || tokenNonce !== (await sha256hex(rawNonce))) return null; // nonce missing / mismatch
  if (!payload.sub) return null;

  return { sub: String(payload.sub), email: typeof payload.email === "string" ? payload.email : null };
}
