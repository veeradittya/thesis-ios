import * as XLSX from "xlsx";

// Parse an uploaded portfolio spreadsheet into a normalized ledger. Broker/export
// formats vary wildly, so we detect the header row and map columns by fuzzy name.

export interface ParsedHolding {
  ticker: string;
  name: string;
  shares: number | null;
  price: number | null;
  value: number | null;
  weight: number | null; // 0..1
  gain: number | null;
  thesis?: string; // optional reason-for-holding; powers the Thesis Monitor card (may be blank)
}

export interface ParsedPortfolio {
  fileName: string;
  portfolioName: string;
  sheetName: string;
  rowCount: number;
  totalValue: number | null;
  holdings: ParsedHolding[];
  mappedColumns: Partial<Record<Field, string>>;
}

type Field = "ticker" | "name" | "shares" | "price" | "value" | "weight" | "gain";

const PATTERNS: Record<Field, RegExp[]> = {
  ticker: [/\bticker\b/, /\bsymbol\b/, /\btkr\b/, /\bcusip\b/],
  name: [/\bname\b/, /description/, /security/, /\bholding\b/, /company/, /\basset\b/, /\bissuer\b/, /fund/],
  shares: [/shares/, /quantity/, /\bqty\b/, /\bunits\b/, /\bposition\b/],
  price: [/\bprice\b/, /\blast\b/, /\bnav\b/, /\bquote\b/],
  value: [/market\s*value/, /mkt\.?\s*val/, /\bvalue\b/, /\bmv\b/, /\bamount\b/, /current\s*value/, /\bbalance\b/, /\bmarket\b/],
  weight: [/weight/, /allocation/, /%\s*of/, /percent/, /\balloc\b/, /\bwt\b/, /%/],
  gain: [/gain/, /\bloss\b/, /unrealized/, /\bp\/?l\b/, /\breturn\b/, /\bchange\b/],
};

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s); // accounting negatives: (123)
  s = s.replace(/[(),$%\s]/g, "");
  if (s === "" || s === "-") return null;
  let n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  if (neg) n = -Math.abs(n);
  return n;
}

function headerScore(row: unknown[]): number {
  let score = 0;
  for (const cell of row) {
    if (typeof cell !== "string") continue;
    const t = cell.toLowerCase();
    for (const pats of Object.values(PATTERNS)) {
      if (pats.some((p) => p.test(t))) {
        score++;
        break;
      }
    }
  }
  return score;
}

// Portfolio name from the filename's leading words (dropping format/date markers):
// "PanAgora_Top10_13F_Q1_2026.xlsx" → "PanAgora".
function derivePortfolioName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  const tokens = base.split(/[_\-\s]+/).filter(Boolean);
  const marker = /^(top\d*|13f|13f-?hr|q[1-4]|fy\d*|h[12]|\d{4}|\d{1,2}|holdings?|portfolio|positions?|export|report|stmt|statement|hr|account)$/i;
  const picked: string[] = [];
  for (const t of tokens) {
    if (marker.test(t)) break;
    picked.push(t);
  }
  const name = (picked.length ? picked : tokens.slice(0, 1)).join(" ").trim();
  if (!name) return "Portfolio";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function parsePortfolioBuffer(buf: ArrayBuffer, fileName = "upload.xlsx"): ParsedPortfolio {
  const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("No sheets found in the file.");
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: null });
  if (!rows.length) throw new Error("The spreadsheet appears to be empty.");

  // Header = the row (within the first 15) with the most field-name matches.
  let headerIdx = 0;
  let best = -1;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const sc = headerScore(rows[i]);
    if (sc > best) {
      best = sc;
      headerIdx = i;
    }
  }
  const header = (rows[headerIdx] as unknown[]).map((c) => (c == null ? "" : String(c)));

  // Map each field to the first matching, not-yet-used column.
  const used = new Set<number>();
  const colOf: Partial<Record<Field, number>> = {};
  (Object.keys(PATTERNS) as Field[]).forEach((field) => {
    for (const pat of PATTERNS[field]) {
      const idx = header.findIndex((h, i) => !used.has(i) && pat.test(h.toLowerCase()));
      if (idx >= 0) {
        colOf[field] = idx;
        used.add(idx);
        break;
      }
    }
  });

  const at = (row: unknown[], f: Field) => (colOf[f] != null ? row[colOf[f]!] : null);

  // Value columns are often quoted in millions/thousands (e.g. "Value ($mm)").
  const valueHeader = colOf.value != null ? header[colOf.value].toLowerCase() : "";
  const valueScale = /\bmm\b|million|\(\$?m\)|\$mn\b/.test(valueHeader)
    ? 1e6
    : /thousand|\(\$?000s?\)|\$000/.test(valueHeader)
      ? 1e3
      : 1;

  const holdings: ParsedHolding[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    if (!row || row.every((c) => c == null || c === "")) continue;

    const tickerStr = at(row, "ticker") != null ? String(at(row, "ticker")).trim() : "";
    const nameStr = at(row, "name") != null ? String(at(row, "name")).trim() : "";
    if (!tickerStr && !nameStr) continue;
    // skip total / subtotal / notes / aggregate rows
    const tl = tickerStr.toLowerCase();
    const nl = nameStr.toLowerCase();
    if (
      /^(total|subtotal|grand\s*total|sum)\b/.test(tl) ||
      (!tickerStr && /\b(total|subtotal)\b/.test(nl)) ||
      /^(cash\b|net\b)/.test(nl)
    )
      continue;

    const shares = toNum(at(row, "shares"));
    const price = toNum(at(row, "price"));
    let value = toNum(at(row, "value"));
    if (value != null) value *= valueScale;
    else if (shares != null && price != null) value = shares * price;
    let weight = toNum(at(row, "weight"));
    if (weight != null && weight > 1.5) weight = weight / 100; // percent → fraction
    const gain = toNum(at(row, "gain"));

    holdings.push({
      ticker: tickerStr || nameStr.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase(),
      name: nameStr || tickerStr,
      shares,
      price,
      value,
      weight,
      gain,
    });
  }

  if (!holdings.length) throw new Error("Couldn't find any holdings rows in the spreadsheet.");

  const { totalValue } = normalizeLedger(holdings);

  const mappedColumns: Partial<Record<Field, string>> = {};
  (Object.keys(colOf) as Field[]).forEach((f) => {
    mappedColumns[f] = header[colOf[f]!];
  });

  return {
    fileName,
    portfolioName: derivePortfolioName(fileName),
    sheetName,
    rowCount: holdings.length,
    totalValue,
    holdings,
    mappedColumns,
  };
}

export async function parsePortfolioFile(file: File): Promise<ParsedPortfolio> {
  return parsePortfolioBuffer(await file.arrayBuffer(), file.name);
}

// Recompute derived fields in place. Two ledger shapes flow through here:
//  • valued ledgers (xlsx upload with shares/price/value): value ← shares×price when missing,
//    totalValue = Σ value, weights ← value / totalValue, sorted value-desc.
//  • weight-only ledgers (the manual editor + weight-column uploads): no dollar values at all —
//    weights are entered directly as fractions, so we just sort weight-desc and leave totalValue null.
// Shared by the xlsx parser and the manual editor so both agree.
export function normalizeLedger(holdings: ParsedHolding[]): { holdings: ParsedHolding[]; totalValue: number | null } {
  for (const h of holdings) {
    if (h.value == null && h.shares != null && h.price != null) h.value = h.shares * h.price;
  }
  const totalValue = holdings.some((h) => h.value != null) ? holdings.reduce((s, h) => s + (h.value || 0), 0) : null;
  if (totalValue && totalValue > 0) {
    for (const h of holdings) h.weight = h.value != null ? h.value / totalValue : null;
    holdings.sort((a, b) => (b.value || 0) - (a.value || 0));
  } else {
    holdings.sort((a, b) => (b.weight || 0) - (a.weight || 0));
  }
  return { holdings, totalValue };
}

// A blank ledger for a freshly signed-in user (they add holdings manually).
export function emptyLedger(name = "My Portfolio"): ParsedPortfolio {
  return { fileName: "", portfolioName: name, sheetName: "", rowCount: 0, totalValue: null, holdings: [], mappedColumns: {} };
}

// A realistic retail demo portfolio: six stocks US retail investors most commonly hold in their
// brokerage accounts, sized like a normal person's account (not an institutional 13F). Reference
// prices are approximate — live quotes come from the prices card; the ledger just needs plausible
// position values. Seeded for guests + first-run so the dashboard has real content.
export function demoPortfolio(name = "Demo Portfolio"): ParsedPortfolio {
  const raw: Array<[string, string, number, number]> = [
    ["AAPL", "Apple Inc.", 82, 220],
    ["MSFT", "Microsoft Corporation", 31, 460],
    ["NVDA", "NVIDIA Corporation", 92, 170],
    ["AMZN", "Amazon.com, Inc.", 60, 220],
    ["TSLA", "Tesla, Inc.", 44, 330],
    ["GOOGL", "Alphabet Inc.", 57, 190],
  ];
  const holdings: ParsedHolding[] = raw.map(([ticker, nm, shares, price]) => ({
    ticker,
    name: nm,
    shares,
    price,
    value: shares * price,
    weight: null,
    gain: null,
  }));
  const { totalValue } = normalizeLedger(holdings); // fills weights, totalValue, value-desc sort
  return { fileName: "", portfolioName: name, sheetName: "", rowCount: holdings.length, totalValue, holdings, mappedColumns: {} };
}

// Build a holding from the manual editor's fields. The editor is weight-only now: the user gives a
// percent (0..100) per asset; we store it as a fraction (0..1). Shares/price/value are always null
// from the editor (they only ever come from an xlsx upload). Blank/invalid weight → null.
export function makeHolding(
  ticker: string,
  name: string,
  weightPct?: number | null,
  thesis?: string | null,
): ParsedHolding {
  const t = ticker.trim().toUpperCase();
  const th = (thesis || "").trim();
  const weight = weightPct != null && Number.isFinite(weightPct) ? weightPct / 100 : null;
  return {
    ticker: t,
    name: name.trim() || t,
    shares: null,
    price: null,
    value: null,
    weight,
    gain: null,
    thesis: th || undefined,
  };
}
