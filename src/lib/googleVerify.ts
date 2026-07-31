// Verify a Google ID token (minted by the native iOS Google Sign-In SDK) SERVER-SIDE, via Google's
// official tokeninfo endpoint — Google checks the signature + expiry for us; we additionally assert
// the issuer and that the audience is one of OUR OAuth client ids. Returns the identity or null.
// Dependency-free (same style as src/lib/turso.ts).
//
// Audience note: the iOS Google Sign-In SDK mints an ID token whose `aud` is the client id it was
// configured against. Configure GIDSignIn with `serverClientID = AUTH_GOOGLE_ID` so `aud` is the WEB
// client id — then the verified `sub` matches web Google sign-in and both are ONE identity. We also
// accept GOOGLE_IOS_CLIENT_ID in case the token is minted for the iOS client id.

export type GoogleIdentity = { sub: string; email: string | null; name: string | null; picture: string | null };

const ALLOWED_AUD = [process.env.AUTH_GOOGLE_ID, process.env.GOOGLE_IOS_CLIENT_ID].filter(Boolean) as string[];
const ALLOWED_ISS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity | null> {
  if (!idToken || typeof idToken !== "string") return null;
  if (!ALLOWED_AUD.length) return null; // no client id configured → cannot validate audience

  let res: Response;
  try {
    res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
      cache: "no-store", // never cache a token verification
    });
  } catch {
    return null;
  }
  if (!res.ok) return null; // Google rejects malformed / bad-signature / expired tokens here

  let p: Record<string, string>;
  try {
    p = (await res.json()) as Record<string, string>;
  } catch {
    return null;
  }

  if (!p.sub) return null;
  if (!ALLOWED_ISS.has(p.iss)) return null;
  if (!ALLOWED_AUD.includes(p.aud)) return null;
  const expMs = Number(p.exp) * 1000;
  if (!Number.isFinite(expMs) || expMs < Date.now()) return null; // belt-and-suspenders vs tokeninfo

  return {
    sub: String(p.sub),
    email: p.email ?? null,
    name: p.name ?? null,
    picture: p.picture ?? null,
  };
}
