// Server-side Turso (libSQL) access over the HTTP pipeline API — no extra deps, Vercel-safe.
// Holds the app's portfolio (holdings + theses) that the scheduled CMA agent reads, and serves
// the agent's written results (per-holding verdicts + run risk memos) back to the dashboard.

const PIPELINE = (process.env.TURSO_DATABASE_URL || "").replace(/^libsql:\/\//, "https://") + "/v2/pipeline";
const TOKEN = process.env.TURSO_AUTH_TOKEN || "";

type Arg = number | string | null;
function typed(v: Arg) {
  if (v == null) return { type: "null" };
  // Hrana protocol: integers are strings (may be 64-bit), floats are JSON numbers, text is a string.
  if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  return { type: "text", value: v };
}

interface Cell {
  value?: string | null;
}

async function pipeline(requests: unknown[]): Promise<Array<{ cols: { name: string }[]; rows: Cell[][] }>> {
  if (!TOKEN || !PIPELINE.startsWith("https://")) throw new Error("Turso is not configured");
  const res = await fetch(PIPELINE, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [...requests, { type: "close" }] }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Turso ${res.status}`);
  const j = await res.json();
  return (j?.results || []).map((r: { type: string; response?: { result?: { cols: { name: string }[]; rows: Cell[][] } } }) => {
    if (r.type !== "ok") throw new Error("Turso stmt failed: " + JSON.stringify(r));
    return r.response?.result ?? { cols: [], rows: [] };
  });
}

// Run one SELECT/DML and return its rows as objects.
async function query(sql: string, args: Arg[] = []): Promise<Record<string, string | null>[]> {
  const [result] = await pipeline([{ type: "execute", stmt: { sql, args: args.map(typed) } }]);
  const names = result.cols.map((c) => c.name);
  return result.rows.map((row) => Object.fromEntries(row.map((cell, i) => [names[i], cell?.value ?? null])));
}

export interface MonitorResult {
  ticker: string;
  name: string;
  verdict: string; // holds_up | weakening | at_risk | watch
  risk: number | null; // 0..100, higher = more risk
  rationale: string; // plain-language "what happened / how it affects you", may carry [text](url) links
  signals: string; // JSON string of the concrete evidence
  researchedAt: string; // when the shared per-asset research last ran
}
export interface MonitorPayload {
  memo: string | null; // one-line, dated portfolio-state overview
  updatedAt: string | null; // when this portfolio's memo was last written
  results: MonitorResult[];
}

// The portfolio's briefing = its per-portfolio overview memo + each holding joined against the
// SHARED per-asset research (one row per ticker, refreshed at most once/24h and reused across every
// portfolio that holds it). No LLM runs here — this is a pure read of pre-computed rows.
export async function getLatestMonitor(userId: string): Promise<MonitorPayload> {
  const [holdings, port] = await Promise.all([
    query("SELECT ticker, name FROM holdings WHERE user_id=?", [userId]),
    query("SELECT memo, updated_at FROM portfolios WHERE user_id=?", [userId]),
  ]);
  const memo = port.length ? port[0].memo : null;
  const updatedAt = port.length ? port[0].updated_at : null;
  if (!holdings.length) return { memo, updatedAt, results: [] };

  const tickers = holdings.map((h) => (h.ticker || "").toUpperCase()).filter(Boolean);
  const placeholders = tickers.map(() => "?").join(",");
  const assetRows = await query(
    `SELECT ticker, verdict, risk, rationale, signals, researched_at FROM assets WHERE ticker IN (${placeholders})`,
    tickers,
  );
  const byTicker = new Map(assetRows.map((r) => [(r.ticker || "").toUpperCase(), r]));

  const results: MonitorResult[] = holdings.map((h) => {
    const t = (h.ticker || "").toUpperCase();
    const a = byTicker.get(t);
    return {
      ticker: t,
      name: h.name || t,
      verdict: a?.verdict || "watch",
      risk: a?.risk != null ? Number(a.risk) : null,
      rationale: a?.rationale || "",
      signals: a?.signals || "{}",
      researchedAt: a?.researched_at || "",
    };
  });
  // Riskiest first; unresearched (null risk) sink to the bottom.
  results.sort((a, b) => (b.risk ?? -1) - (a.risk ?? -1));
  return { memo, updatedAt, results };
}

// Read a user's holdings back out of Turso (the account's server-side portfolio). Lets the app
// restore an account's portfolio on a device that has no local copy yet, so it follows the account.
export async function getHoldings(
  userId: string,
): Promise<Array<{ ticker: string; name: string | null; weight: number | null; thesis: string | null }>> {
  const rows = await query("SELECT ticker, name, weight, thesis FROM holdings WHERE user_id=? ORDER BY weight DESC", [userId]);
  return rows.map((r) => ({
    ticker: (r.ticker || "").toUpperCase(),
    name: r.name,
    weight: r.weight != null ? Number(r.weight) : null,
    thesis: r.thesis,
  }));
}

// Replace a user's holdings (portfolio + theses) — the source the scheduled agent reads each pass.
export async function syncHoldings(
  userId: string,
  holdings: Array<{ ticker: string; name?: string | null; weight?: number | null; thesis?: string | null }>,
): Promise<number> {
  const requests: unknown[] = [{ type: "execute", stmt: { sql: "DELETE FROM holdings WHERE user_id=?", args: [typed(userId)] } }];
  let n = 0;
  for (const h of holdings) {
    const ticker = (h.ticker || "").trim().toUpperCase();
    if (!ticker) continue;
    n++;
    requests.push({
      type: "execute",
      stmt: {
        sql: "INSERT OR REPLACE INTO holdings (user_id,ticker,name,weight,thesis) VALUES (?,?,?,?,?)",
        args: [typed(userId), typed(ticker), typed(h.name ?? null), typed(h.weight ?? null), typed((h.thesis || "").trim() || null)],
      },
    });
  }
  await pipeline(requests);
  return n;
}

// Record a sign-in: upsert the user's identity + tenure. first_seen is set once (on the first-ever
// sign-in); last_seen and sign_in_count are bumped every time. Gives the agent a durable "is this a
// new user?" signal and powers the backend monitoring of who has signed in.
export async function recordSignIn(userId: string, email: string | null, name: string | null): Promise<void> {
  const now = new Date().toISOString();
  await pipeline([
    {
      type: "execute",
      stmt: {
        sql: `INSERT INTO users (user_id, email, name, first_seen, last_seen, sign_in_count)
              VALUES (?, ?, ?, ?, ?, 1)
              ON CONFLICT(user_id) DO UPDATE SET
                email = excluded.email,
                name = excluded.name,
                last_seen = excluded.last_seen,
                sign_in_count = users.sign_in_count + 1`,
        args: [typed(userId), typed(email), typed(name), typed(now), typed(now)],
      },
    },
  ]);
}

// Append one activity event for a user (sign-in, a feature view, a portfolio edit, a timed data
// retrieval, …). durationMs, when present, is how long that retrieval took — the dashboard shows the
// exact lag and labels it fast/standard/slow. Powers the backend monitoring dashboard's per-user
// activity timeline. Best-effort — callers ignore failures.
export async function logActivity(
  userId: string | null,
  event: string,
  detail: string | null,
  durationMs: number | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  const ms = durationMs != null && Number.isFinite(durationMs) ? Math.round(durationMs) : null;
  await pipeline([
    {
      type: "execute",
      stmt: {
        sql: "INSERT INTO activity_log (user_id, ts, event, detail, duration_ms) VALUES (?,?,?,?,?)",
        args: [typed(userId), typed(now), typed(event), typed(detail), typed(ms)],
      },
    },
  ]);
}

// Backfill/refresh a user's profile (Google email + name, last_seen, and the device they're on) from
// any authenticated request, WITHOUT counting it as a sign-in. This captures the identity of users
// who signed in before sign-in recording shipped — their name/email fill in the moment they next use
// the app — and keeps their most-recent device (parsed from the User-Agent) up to date.
export async function touchUser(
  userId: string,
  email: string | null,
  name: string | null,
  device: string | null = null,
  userAgent: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  await pipeline([
    {
      type: "execute",
      stmt: {
        sql: `INSERT INTO users (user_id, email, name, first_seen, last_seen, sign_in_count, device, user_agent)
              VALUES (?, ?, ?, ?, ?, 0, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET
                email = COALESCE(excluded.email, users.email),
                name = COALESCE(excluded.name, users.name),
                last_seen = excluded.last_seen,
                device = COALESCE(excluded.device, users.device),
                user_agent = COALESCE(excluded.user_agent, users.user_agent)`,
        args: [typed(userId), typed(email), typed(name), typed(now), typed(now), typed(device), typed(userAgent)],
      },
    },
  ]);
}
