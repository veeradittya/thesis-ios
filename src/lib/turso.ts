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

// Per-ticker analyst-sentiment brief (a succinct plain-language read on the analyst consensus,
// written by the daily agent into assets.analyst_brief). Feeds the Analyst Sentiment cards.
export async function getAnalystBriefs(tickers: string[]): Promise<Record<string, string>> {
  const syms = [...new Set(tickers.map((t) => (t || "").trim().toUpperCase()).filter(Boolean))];
  if (!syms.length) return {};
  const placeholders = syms.map(() => "?").join(",");
  const rows = await query(
    `SELECT ticker, analyst_brief FROM assets WHERE ticker IN (${placeholders}) AND analyst_brief IS NOT NULL`,
    syms,
  );
  const out: Record<string, string> = {};
  for (const r of rows) {
    const t = (r.ticker || "").toUpperCase();
    if (r.analyst_brief) out[t] = r.analyst_brief;
  }
  return out;
}

// Resolve the STABLE Google-sub user id for an email — the canonical row whose user_id is all
// digits (the Google `sub`). Used to heal legacy sessions whose token.sub is a pre-fix random UUID.
// Returns null if no Google-sub row exists yet for that email.
export async function getCanonicalUserId(email: string): Promise<string | null> {
  const rows = await query("SELECT user_id, sign_in_count FROM users WHERE email=?", [email]);
  const numeric = rows
    .filter((r) => /^\d+$/.test(r.user_id || ""))
    .sort((a, b) => Number(b.sign_in_count ?? 0) - Number(a.sign_in_count ?? 0));
  return numeric[0]?.user_id ?? null;
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

// Per-portfolio modern-portfolio-theory analytics (efficient frontier, per-asset return/risk/Sharpe,
// correlations, min-variance + tangency portfolios) — computed by the app whenever holdings change and
// stored so the daily CMA agent can READ them and reason over them. The agent writes the plain-language
// `ai_overview` back into the SAME row; the app-side write below never clobbers it (ON CONFLICT preserves).
export async function setPortfolioAnalytics(userId: string, analytics: unknown): Promise<void> {
  const now = new Date().toISOString();
  await pipeline([
    { type: "execute", stmt: { sql: "CREATE TABLE IF NOT EXISTS portfolio_analytics (user_id TEXT PRIMARY KEY, analytics TEXT, ai_overview TEXT, updated_at TEXT)", args: [] } },
    {
      type: "execute",
      stmt: {
        sql: `INSERT INTO portfolio_analytics (user_id, analytics, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET analytics = excluded.analytics, updated_at = excluded.updated_at`,
        args: [typed(userId), typed(analytics == null ? null : JSON.stringify(analytics)), typed(now)],
      },
    },
  ]);
}

// Read a portfolio's stored analytics + the agent's ai_overview. Returns null if the table/row don't
// exist yet (no sync has happened) so callers fall back to computing client-side.
export async function getPortfolioAnalytics(
  userId: string,
): Promise<{ analytics: unknown; aiOverview: string | null; updatedAt: string | null } | null> {
  try {
    const rows = await query("SELECT analytics, ai_overview, updated_at FROM portfolio_analytics WHERE user_id=?", [userId]);
    if (!rows.length) return null;
    const r = rows[0];
    return { analytics: r.analytics ? JSON.parse(r.analytics) : null, aiOverview: r.ai_overview ?? null, updatedAt: r.updated_at ?? null };
  } catch {
    return null; // table may not exist yet
  }
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

// Read a user's stored display name (users.name). Used by the beta-code sign-in to restore the name a
// tester chose during onboarding, so re-entering their code retrieves the same identity on any device.
export async function getUserName(userId: string): Promise<string | null> {
  const rows = await query("SELECT name FROM users WHERE user_id=?", [userId]);
  return rows[0]?.name ?? null;
}

// Persist a user's chosen display name (from onboarding). Upsert so it works even if the sign-in row
// wasn't written yet; keeps any existing email and bumps last_seen.
export async function setUserName(userId: string, name: string): Promise<void> {
  const now = new Date().toISOString();
  await pipeline([
    {
      type: "execute",
      stmt: {
        sql: `INSERT INTO users (user_id, email, name, first_seen, last_seen, sign_in_count)
              VALUES (?, NULL, ?, ?, ?, 0)
              ON CONFLICT(user_id) DO UPDATE SET
                name = excluded.name,
                last_seen = excluded.last_seen`,
        args: [typed(userId), typed(name), typed(now), typed(now)],
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

// Append MANY activity events for a user in a single DB round-trip (all INSERTs in one pipeline).
// The client batches its events and flushes them together, so one page's worth of activity is one
// write instead of one-per-event. Each event carries its own client timestamp so ordering/timing is
// preserved despite the delayed flush. Best-effort.
export async function logActivityBatch(
  userId: string,
  events: Array<{ event: string; detail?: string | null; durationMs?: number | null; ts?: string | null }>,
): Promise<void> {
  if (!events.length) return;
  const requests = events.map((e) => {
    const ms = e.durationMs != null && Number.isFinite(e.durationMs) ? Math.round(e.durationMs) : null;
    const ts = e.ts && !Number.isNaN(Date.parse(e.ts)) ? e.ts : new Date().toISOString();
    return {
      type: "execute",
      stmt: {
        sql: "INSERT INTO activity_log (user_id, ts, event, detail, duration_ms) VALUES (?,?,?,?,?)",
        args: [typed(userId), typed(ts), typed(e.event), typed(e.detail ?? null), typed(ms)],
      },
    };
  });
  await pipeline(requests);
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

// ── Push notifications ──────────────────────────────────────────────────────
// One row per device token, keyed by token (a token belongs to exactly one account at a time —
// re-registering the same token just re-points it and refreshes updated_at). user_id is the same
// account id holdings/portfolios are keyed by.
export async function registerPushToken(token: string, userId: string, platform: string | null): Promise<void> {
  await pipeline([
    {
      type: "execute",
      stmt: {
        sql: `INSERT INTO push_tokens (token, user_id, platform, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(token) DO UPDATE SET
                user_id = excluded.user_id,
                platform = excluded.platform,
                updated_at = excluded.updated_at`,
        args: [typed(token), typed(userId), typed(platform), typed(Date.now())],
      },
    },
  ]);
}

export async function deletePushToken(token: string): Promise<void> {
  await pipeline([{ type: "execute", stmt: { sql: "DELETE FROM push_tokens WHERE token=?", args: [typed(token)] } }]);
}

// Full account deletion (App Store Guideline 5.1.1(v) — in-app account + data removal). Removes EVERY
// row this user owns across all user-scoped tables in ONE pipeline (atomic-ish, single round trip).
// Never touches the shared `assets` table (per-ticker research reused across all portfolios).
// Irreversible. Table names are constants (not user input); user_id is bound.
export async function deleteAccount(userId: string): Promise<void> {
  const uid = (userId || "").trim();
  if (!uid) throw new Error("deleteAccount: missing userId");
  const tables = ["holdings", "portfolios", "push_tokens", "users", "activity_log", "theses"];
  await pipeline(tables.map((t) => ({ type: "execute", stmt: { sql: `DELETE FROM ${t} WHERE user_id=?`, args: [typed(uid)] } })));
}

// Shared, persistent cache for per-article news takeaways (see src/lib/newsTakeaways.ts). Keyed by the
// article/update id; a takeaway for a fixed article is immutable, so entries never expire. Written once
// by whichever request first summarizes an article and reused across every user + serverless instance,
// so each article is sent to the LLM at most once regardless of how many people load the feed.
export async function getNewsTakeaways(ids: string[]): Promise<Record<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return {};
  const placeholders = uniq.map(() => "?").join(",");
  const rows = await query(`SELECT id, takeaway FROM news_takeaways WHERE id IN (${placeholders})`, uniq);
  const out: Record<string, string> = {};
  for (const r of rows) if (r.id && r.takeaway) out[r.id] = r.takeaway;
  return out;
}

export async function putNewsTakeaways(entries: Array<{ id: string; takeaway: string }>): Promise<void> {
  const rows = entries.filter((e) => e.id && e.takeaway);
  if (!rows.length) return;
  const now = new Date().toISOString();
  await pipeline(
    rows.map((e) => ({
      type: "execute",
      stmt: { sql: "INSERT OR REPLACE INTO news_takeaways (id, takeaway, created_at) VALUES (?,?,?)", args: [typed(e.id), typed(e.takeaway), typed(now)] },
    })),
  );
}

export interface PushTarget { userId: string; token: string; platform: string | null }

// Device tokens belonging to users whose Daily Brief (portfolios.updated_at, written by the agent)
// was refreshed within `windowMs` — i.e. everyone who got a fresh brief this run. portfolios.updated_at
// is an ISO string, so we parse + filter in JS to avoid string-comparison edge cases.
export async function getFreshBriefPushTargets(windowMs: number): Promise<PushTarget[]> {
  const rows = await query(
    `SELECT p.user_id AS user_id, p.updated_at AS brief_at, t.token AS token, t.platform AS platform
     FROM portfolios p JOIN push_tokens t ON t.user_id = p.user_id`,
  );
  const cutoff = Date.now() - windowMs;
  const out: PushTarget[] = [];
  for (const r of rows) {
    const at = r.brief_at ? Date.parse(r.brief_at) : NaN;
    if (Number.isFinite(at) && at >= cutoff && r.token) out.push({ userId: r.user_id!, token: r.token, platform: r.platform });
  }
  return out;
}
