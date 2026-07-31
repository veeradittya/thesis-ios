// Server-side Guardian Open Platform client. The API key stays on the server.
// Free tier is 60 req/min + 500/day, so we cache the assembled payload (no websocket
// exists — alerts are poll-based; see NewsAlertCard which polls /api/news).

import { guardianFetch } from "@/lib/guardianFetch";

const BASE = "https://content.guardianapis.com";

export interface NewsItem {
  id: string;
  title: string;
  trailText: string | null;
  section: string | null;
  url: string;
  published: string; // ISO
  byline: string | null;
  image: string | null; // thumbnail URL, or null when the article has no image
  imageAlt: string | null;
  takeaway?: string; // optional AI takeaway (attached by the route when ?takeaways=1)
}
export interface NewsPayload {
  source: string;
  fetchedAt: string;
  query: string;
  items: NewsItem[];
}

interface GuAsset {
  type?: string;
  file?: string;
  typeData?: { width?: number; altText?: string };
}
interface GuResult {
  id: string;
  type: string;
  sectionName?: string;
  webPublicationDate: string;
  webTitle: string;
  webUrl: string;
  fields?: { headline?: string; trailText?: string; thumbnail?: string; byline?: string };
  elements?: Array<{ type: string; assets?: GuAsset[] }>;
}

const stripHtml = (s?: string | null) => (s ? s.replace(/<[^>]+>/g, "").trim() || null : null);

// Prefer the standard thumbnail crop; fall back to a mid-size image element asset.
function pickImage(r: GuResult): { url: string | null; alt: string | null } {
  if (r.fields?.thumbnail) return { url: r.fields.thumbnail, alt: null };
  const el = r.elements?.find((e) => e.type === "image");
  const assets = (el?.assets || []).filter((a) => a.file);
  if (assets.length) {
    const sorted = [...assets].sort((a, b) => (a.typeData?.width || 0) - (b.typeData?.width || 0));
    const pick = sorted.find((a) => (a.typeData?.width || 0) >= 300) || sorted[sorted.length - 1];
    if (pick?.file) return { url: pick.file, alt: pick.typeData?.altText || null };
  }
  return { url: null, alt: null };
}

let cache: { at: number; key: string; data: NewsPayload } | null = null;
const TTL = 5 * 60 * 1000; // 5 min — keeps us well under 500 Guardian calls/day

// Macro / geopolitics / finance terms blended with the portfolio companies, so the feed
// is "portfolio + world context". The sections below keep it serious (drop lifestyle fluff).
const MACRO =
  '"stock market" OR "Wall Street" OR "Federal Reserve" OR "interest rates" OR inflation OR recession OR tariffs OR sanctions OR geopolitics OR "central bank"';
const SECTIONS = "business|technology|world|us-news";

export async function getNews(query: string): Promise<NewsPayload> {
  const companies = (query || "").trim();
  const q = companies ? `(${companies}) OR (${MACRO})` : MACRO;
  if (cache && cache.key === q && Date.now() - cache.at < TTL) return cache.data;

  const params = new URLSearchParams({
    q,
    "order-by": "newest",
    "page-size": "20",
    section: SECTIONS,
    tag: "-tone/reviews", // exclude product/gadget reviews (Ring, Oura, etc.) — useless for the workflow
    "show-fields": "headline,trailText,thumbnail,byline",
    "show-elements": "image",
  });

  let res: Response;
  try {
    // no-store: Next's Data Cache was serving a stuck multi-day-stale response for specific query keys
    // (a reordered query — a cache miss — returned fresh data while the original stayed frozen). The
    // in-memory `cache` above (5-min TTL) still throttles Guardian API calls. Same fix as getLiveBlog.
    res = await guardianFetch(`${BASE}/search?${params.toString()}`, { cache: "no-store" });
  } catch (e) {
    if (cache && cache.key === q) return cache.data; // serve stale on network error
    throw e;
  }
  if (!res.ok) {
    if (cache && cache.key === q) return cache.data; // serve stale on API error
    throw new Error(`Guardian ${res.status}`);
  }

  const j = await res.json();
  const results: GuResult[] = j?.response?.results || [];
  const items: NewsItem[] = results.map((r) => {
    const img = pickImage(r);
    return {
      id: r.id,
      title: stripHtml(r.fields?.headline) || r.webTitle,
      trailText: stripHtml(r.fields?.trailText),
      section: r.sectionName || null,
      url: r.webUrl,
      published: r.webPublicationDate,
      byline: stripHtml(r.fields?.byline),
      image: img.url,
      imageAlt: img.alt,
    };
  });

  const data: NewsPayload = { source: "The Guardian", fetchedAt: new Date().toISOString(), query: q, items };
  cache = { at: Date.now(), key: q, data };
  return data;
}

// ─── Full article (in-app reader) ─────────────────────────────────────────────

export interface Article {
  id: string;
  title: string;
  byline: string | null;
  published: string;
  section: string | null;
  url: string;
  image: string | null;
  imageAlt: string | null;
  paragraphs: string[];
  source: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "’")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
const cleanText = (s?: string | null) => (s ? decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "");

// Pull readable paragraphs from the Guardian body HTML (safe — no raw HTML is rendered).
function toParagraphs(bodyHtml?: string): string[] {
  if (!bodyHtml) return [];
  return [...bodyHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => cleanText(m[1])).filter(Boolean);
}

interface GuContent {
  id: string;
  sectionName?: string;
  webPublicationDate: string;
  webTitle: string;
  webUrl: string;
  fields?: { headline?: string; byline?: string; body?: string; thumbnail?: string };
  elements?: Array<{ type: string; assets?: GuAsset[] }>;
}

const articleCache = new Map<string, { at: number; data: Article }>();
const ARTICLE_TTL = 30 * 60 * 1000;

export async function getArticle(id: string): Promise<Article> {
  const hit = articleCache.get(id);
  if (hit && Date.now() - hit.at < ARTICLE_TTL) return hit.data;

  const params = new URLSearchParams({
    "show-fields": "headline,byline,body,thumbnail",
    "show-elements": "image",
  });
  const res = await guardianFetch(`${BASE}/${id}?${params.toString()}`, { next: { revalidate: 1800 } });
  if (!res.ok) {
    if (hit) return hit.data;
    throw new Error(`Guardian ${res.status}`);
  }
  const c: GuContent | undefined = (await res.json())?.response?.content;
  if (!c) throw new Error("Article not found");

  // Hero image: prefer a larger (<=1200w) asset, else the thumbnail.
  let image: string | null = c.fields?.thumbnail || null;
  let imageAlt: string | null = null;
  const el = c.elements?.find((e) => e.type === "image");
  const assets = (el?.assets || []).filter((a) => a.file).sort((a, b) => (b.typeData?.width || 0) - (a.typeData?.width || 0));
  const big = assets.find((a) => (a.typeData?.width || 0) <= 1200) || assets[0];
  if (big?.file) {
    image = big.file;
    imageAlt = big.typeData?.altText || null;
  }

  const data: Article = {
    id: c.id,
    title: cleanText(c.fields?.headline) || c.webTitle,
    byline: cleanText(c.fields?.byline) || null,
    published: c.webPublicationDate,
    section: c.sectionName || null,
    url: c.webUrl,
    image,
    imageAlt,
    paragraphs: toParagraphs(c.fields?.body),
    source: "The Guardian",
  };
  articleCache.set(id, { at: Date.now(), data });
  return data;
}

// ─── Live-blog latest update (rolling live blogs show this on the news card) ───

export const isLiveBlog = (title: string) => /[–—-]\s*(live|as it happened)\s*$/i.test((title || "").trim());

export interface LiveUpdate {
  blockId: string;
  text: string;
  image: string | null;
  published: string;
}

interface GuBlock {
  id?: string;
  publishedDate?: string;
  attributes?: { keyEvent?: boolean; title?: string };
  elements?: Array<{ type: string; textTypeData?: { html?: string }; assets?: Array<{ file?: string; typeData?: { width?: number } }> }>;
}

// Plain text of a block from its TEXT elements only (rich-link / image elements skipped).
const blockText = (b: GuBlock) => cleanText((b.elements || []).filter((e) => e.type === "text").map((e) => e.textTypeData?.html || "").join(" "));

// The block's first image element URL (a mid-size asset), or null if it has no image.
function blockImage(b: GuBlock): string | null {
  const el = (b.elements || []).find((e) => e.type === "image");
  const assets = (el?.assets || []).filter((a) => a.file);
  if (!assets.length) return null;
  const sorted = [...assets].sort((x, y) => (x.typeData?.width || 0) - (y.typeData?.width || 0));
  const pick = sorted.find((a) => (a.typeData?.width || 0) >= 300) || sorted[sorted.length - 1];
  return pick?.file || null;
}

// Generic sign-off / wrap-up blocks that aren't a real news update.
function isCloser(b: GuBlock): boolean {
  const title = (b.attributes?.title || "").trim();
  const head = `${title} ${blockText(b)}`.slice(0, 160).toLowerCase();
  return (
    /clos(e|ed|ing)\s+(the\s+|our\s+|down\s+)?(blog|live|coverage)/.test(head) ||
    /we are now closing|this concludes our live|time to wrap (up|things)|wrapping (up|things)|thanks for (following|joining|reading)|that'?s (all|it) (for|from)|we'?ll be back|signing off|brings.{0,12}to (a |an )?(close|end)/.test(head) ||
    /^(closing\s+(summary|post|thoughts)|summary|recap|key events?)\b/i.test(title)
  );
}

const liveCache = new Map<string, { at: number; data: LiveUpdate[] }>();
const LIVE_TTL = 3 * 60 * 1000; // live blogs roll — keep this short

// The latest N SUBSTANTIVE updates of a rolling live blog (generic closers skipped), newest
// first — each with block id, text, image, and timestamp. Cached ~3 min.
export async function getLiveUpdates(id: string, limit = 3): Promise<LiveUpdate[]> {
  if (id.includes("#")) return []; // composite update id, not a real blog — guard against cache mishaps
  const hit = liveCache.get(id);
  if (hit && Date.now() - hit.at < LIVE_TTL) return hit.data;

  let data: LiveUpdate[] = [];
  let ok = false;
  try {
    // no-store: live blogs roll constantly and Next's Data Cache was serving a stale/empty response
    const res = await guardianFetch(`${BASE}/${id}?show-blocks=body:latest:15`, { cache: "no-store" });
    if (res.ok) {
      ok = true;
      const blocksObj = (await res.json())?.response?.content?.blocks;
      let blocks: GuBlock[] = [];
      const rbb = blocksObj?.requestedBodyBlocks;
      if (rbb) for (const k of Object.keys(rbb)) if (Array.isArray(rbb[k])) blocks = blocks.concat(rbb[k]);
      if (!blocks.length) blocks = blocksObj?.body || [];
      blocks = blocks.slice().sort((a, b) => Date.parse(b.publishedDate || "") - Date.parse(a.publishedDate || ""));
      data = blocks
        .filter((b) => b.id && !isCloser(b) && blockText(b))
        .slice(0, limit)
        .map((b) => ({ blockId: b.id as string, text: blockText(b), image: blockImage(b), published: b.publishedDate || "" }));
    }
  } catch {
    /* leave empty — stale fallback below */
  }
  // Serve stale on any failure — never drop a live blog's updates on a transient error.
  if (!ok && hit) return hit.data;
  liveCache.set(id, { at: Date.now(), data });
  return data;
}
