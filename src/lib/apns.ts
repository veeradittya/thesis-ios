// Send a push to iOS device tokens over APNs HTTP/2 (token-based auth). Node-only: uses `node:http2`
// (never fetch — APNs needs HTTP/2) and `node:crypto` for the ES256 provider JWT. Every value comes
// from env; nothing is hardcoded. Import only from a `runtime = "nodejs"` route.
import http2 from "node:http2";
import crypto from "node:crypto";

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// APNs provider token: ES256 JWT signed with the .p8 key. Valid up to 1h; cache and refresh well
// under that. Signature must be JOSE/raw (r‖s) — `dsaEncoding: "ieee-p1363"` gives exactly that.
let cachedJwt: { token: string; iat: number } | null = null;
function providerJwt(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  if (cachedJwt && nowSec - cachedJwt.iat < 3000) return cachedJwt.token; // < 50 min old

  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const pem = (process.env.APNS_KEY || "").replace(/\\n/g, "\n"); // env may store the .p8 with escaped newlines
  if (!keyId || !teamId || !pem) throw new Error("APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID not set");

  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat: nowSec }));
  const signingInput = `${header}.${payload}`;
  const sig = crypto.sign("sha256", Buffer.from(signingInput), { key: crypto.createPrivateKey(pem), dsaEncoding: "ieee-p1363" });
  const token = `${signingInput}.${b64url(sig)}`;
  cachedJwt = { token, iat: nowSec };
  return token;
}

// The daily-brief alert. `view: "brief"` is the custom key the native app reads to deep-link to Brief.
export const BRIEF_PAYLOAD = {
  aps: { alert: { title: "Thesis", body: "Your brief for today is ready to view." }, sound: "default" },
  view: "brief",
} as const;

export interface ApnsResult { token: string; ok: boolean; status: number; reason?: string }

// Send `payload` to each token over a single multiplexed HTTP/2 connection. Never throws per-token —
// each token gets an {ok,status,reason}; a status 410 or reason Unregistered/BadDeviceToken means the
// token is dead and the caller should delete it. Throws only if the connection or config is unusable.
export async function sendApnsPush(tokens: string[], payload: unknown = BRIEF_PAYLOAD): Promise<ApnsResult[]> {
  if (!tokens.length) return [];
  const topic = process.env.APNS_BUNDLE_ID;
  if (!topic) throw new Error("APNS_BUNDLE_ID not set");
  const host = process.env.APNS_ENV === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  const jwt = providerJwt();
  const body = JSON.stringify(payload);

  const client = http2.connect(`https://${host}`);
  const results: ApnsResult[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("error", reject); // connection-level failure (DNS, TLS, refused)
      let pending = tokens.length;
      const done = () => { if (--pending === 0) resolve(); };
      for (const token of tokens) {
        const req = client.request({
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${jwt}`,
          "apns-topic": topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "content-type": "application/json",
        });
        let status = 0;
        let data = "";
        req.on("response", (h) => { status = Number(h[":status"]) || 0; });
        req.setEncoding("utf8");
        req.on("data", (c) => (data += c));
        req.on("end", () => {
          let reason: string | undefined;
          try { reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined; } catch {}
          results.push({ token, ok: status === 200, status, reason });
          done();
        });
        req.on("error", (e) => {
          results.push({ token, ok: false, status: 0, reason: e instanceof Error ? e.message : "stream error" });
          done();
        });
        req.end(body);
      }
    });
  } finally {
    client.close();
  }
  return results;
}
