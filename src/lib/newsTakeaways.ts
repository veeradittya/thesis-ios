// Server-side "takeaway protocol": one concise, factual, <=16-word takeaway per Guardian feed item via
// Claude Haiku (the native Anthropic API, ANTHROPIC_API_KEY). Non-live items summarize the article body;
// rolling live blogs summarize their last SUBSTANTIVE update (not the headline).
//
// Caching is two-tier and the main cost control: an in-memory L1 (per instance, 30-min TTL) over a shared
// Turso L2 (persistent, keyed by article id, no expiry). A takeaway for a fixed article is immutable, so
// each article is sent to the LLM at most ONCE across all users and all serverless instances.

import Anthropic from "@anthropic-ai/sdk";
import { getArticle, getLiveUpdates, isLiveBlog, type NewsItem, type LiveUpdate } from "@/lib/guardian";
import { getNewsTakeaways, putNewsTakeaways } from "@/lib/turso";

const MODEL = "claude-haiku-4-5"; // the cheapest Anthropic model — plenty for a one-line summary

const SYSTEM = [
  "You write concise news takeaways.",
  "You are given a set of news articles (each with an id, headline, and text).",
  "Call the emit_takeaways tool exactly once, with ONE entry per article, echoing each id exactly.",
  "Rules per entry:",
  "- takeaway: a single concise, headline-style line of AT MOST 16 words, ending with a period.",
  "- Preserve the article's specific angle as signaled by its HEADLINE. If the headline emphasizes a reaction, condemnation, outcry, ruling, deal, or other new development, the takeaway must capture THAT specific angle — not merely the underlying background event readers already know.",
  "- Capture the single most important fact (the lede).",
  "- Strictly factual: use ONLY facts in the article. Do not invent, exaggerate, editorialize, or hedge. No meta phrases ('this article…'). No 'reportedly/could/may' unless the article itself hedges.",
].join("\n");

const LIVE_SYSTEM = [
  "You summarize the latest update from rolling news live blogs.",
  "You are given items, each with an id, the live blog's topic, and the text of its most recent substantive update.",
  "Call the emit_takeaways tool exactly once, with ONE entry per id, echoing each id exactly.",
  "Rules per entry:",
  "- takeaway: summarize THAT UPDATE (the new development it reports), not the blog's overall topic, in a single headline-style line of AT MOST 16 words, ending with a period.",
  "- Strictly factual: use ONLY facts in the update text. Do not invent, exaggerate, editorialize, or hedge. No meta phrases ('this update…', 'the live blog…').",
].join("\n");

// Anthropic-native forced tool: the response's tool_use block carries `input` already parsed as an object.
const TAKEAWAY_TOOL: Anthropic.Tool = {
  name: "emit_takeaways",
  description: "Return one concise takeaway for every item, in order.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "the id exactly as given, e.g. a1" },
            takeaway: { type: "string", description: "headline-style, <=16 words, ends with a period" },
          },
          required: ["id", "takeaway"],
        },
      },
    },
    required: ["items"],
  },
};

interface Prepared {
  k: string;
  id: string;
  block: string;
}

// One Haiku batch → map of real id → takeaway. Returns {} on any failure (card falls back to headlines).
async function runBatch(prepared: Prepared[], system: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !prepared.length) return map;

  const user = `Articles:\n\n${prepared.map((p) => p.block).join("\n\n---\n\n")}`;
  try {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2500,
      temperature: 0.2,
      system,
      tools: [TAKEAWAY_TOOL],
      tool_choice: { type: "tool", name: "emit_takeaways" },
      messages: [{ role: "user", content: user }],
    });
    const tool = res.content.find((b) => b.type === "tool_use");
    const items = tool?.type === "tool_use" ? (tool.input as { items?: Array<{ id?: string; takeaway?: string }> }).items : undefined;
    if (items) {
      const byKey = new Map<string, string>();
      for (const e of items) if (e.id && e.takeaway) byKey.set(e.id, e.takeaway);
      for (const p of prepared) {
        const tw = byKey.get(p.k);
        if (tw) map[p.id] = tw;
      }
    }
  } catch {
    /* API error → empty map; card falls back to headlines */
  }
  return map;
}

// ─── Non-live articles → takeaway from the article body. L1 (in-memory, 30-min TTL) over L2 (shared Turso,
// no expiry). Only genuinely-new articles — missing from both caches — are sent to the LLM. ──
const takeCache = new Map<string, { at: number; tk: string }>();
const TTL = 30 * 60 * 1000;

export async function getTakeaways(items: NewsItem[]): Promise<Record<string, string>> {
  const targets = items.filter((it) => !isLiveBlog(it.title));
  if (!targets.length) return {};
  const now = Date.now();
  for (const [id, v] of takeCache) if (now - v.at > TTL) takeCache.delete(id); // evict stale L1

  const out: Record<string, string> = {};

  // L1: in-memory
  const l1Misses: NewsItem[] = [];
  for (const it of targets) {
    const v = takeCache.get(it.id);
    if (v) out[it.id] = v.tk;
    else l1Misses.push(it);
  }
  if (!l1Misses.length) return out;

  // L2: shared Turso cache (persistent). Best-effort — a lookup failure just falls through to the LLM.
  let l2: Record<string, string> = {};
  try {
    l2 = await getNewsTakeaways(l1Misses.map((it) => it.id));
  } catch {
    /* ignore */
  }
  const llmMisses: NewsItem[] = [];
  for (const it of l1Misses) {
    const tw = l2[it.id];
    if (tw) {
      out[it.id] = tw;
      takeCache.set(it.id, { at: now, tk: tw });
    } else {
      llmMisses.push(it);
    }
  }
  if (!llmMisses.length) return out;

  // LLM: only the articles missing from both caches. Write results back to L1 + L2.
  const prepared = await Promise.all(
    llmMisses.map(async (it, i) => {
      let content = it.trailText || "";
      try {
        const a = await getArticle(it.id);
        if (a.paragraphs?.length) content = a.paragraphs.join("\n\n");
      } catch {
        /* fall back to trailText */
      }
      if (!content) content = it.trailText || it.title;
      const k = `a${i + 1}`;
      return { k, id: it.id, block: `id: ${k}\nHeadline: ${it.title}\nFull text: ${content.slice(0, 3500)}` };
    }),
  );
  const fresh = await runBatch(prepared, SYSTEM);
  const toPersist: Array<{ id: string; takeaway: string }> = [];
  for (const it of llmMisses) {
    const tw = fresh[it.id];
    if (tw) {
      out[it.id] = tw;
      takeCache.set(it.id, { at: now, tk: tw });
      toPersist.push({ id: it.id, takeaway: tw });
    }
  }
  if (toPersist.length) {
    try {
      await putNewsTakeaways(toPersist);
    } catch {
      /* best-effort persistence */
    }
  }
  return out;
}

// ─── Rolling live blogs → each exploded into its latest few updates, each Haiku-summarized. Memoized per
// update block id (an update's text is fixed once posted), same L1 + Turso L2 tiers as above. ──
const liveTakeCache = new Map<string, { at: number; tk: string }>();
const LIVE_TTL = 30 * 60 * 1000;
const UPDATES_PER_BLOG = 3;

// Distinct, readable fallback when the LLM takeaway is unavailable: the update's own first
// sentence — so a blog's exploded rows never collapse into one identical headline.
function snippet(text: string, maxWords = 18): string {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const sentence = clean.match(/^.{24,}?[.!?](?=\s|$)/)?.[0] || clean;
  const words = sentence.split(" ");
  return words.length > maxWords ? words.slice(0, maxWords).join(" ").replace(/[,;:]$/, "") + "…" : sentence;
}

export async function getLiveItems(live: NewsItem[]): Promise<NewsItem[]> {
  if (!live.length) return [];

  const perBlog = await Promise.all(
    live.map(async (blog) => ({ blog, updates: await getLiveUpdates(blog.id, UPDATES_PER_BLOG).catch(() => [] as LiveUpdate[]) })),
  );
  const flat: Array<{ blog: NewsItem; u: LiveUpdate }> = [];
  for (const { blog, updates } of perBlog) for (const u of updates) flat.push({ blog, u });
  if (!flat.length) return [];

  const now = Date.now();
  for (const [id, v] of liveTakeCache) if (now - v.at > LIVE_TTL) liveTakeCache.delete(id); // evict stale L1
  const keyOf = (x: { blog: NewsItem; u: LiveUpdate }) => `${x.blog.id}#${x.u.blockId}`;

  // L1: in-memory
  const l1Misses = flat.filter((x) => !liveTakeCache.has(keyOf(x)));
  if (l1Misses.length) {
    // L2: shared Turso cache
    let l2: Record<string, string> = {};
    try {
      l2 = await getNewsTakeaways(l1Misses.map(keyOf));
    } catch {
      /* ignore */
    }
    const llmMisses: Array<{ blog: NewsItem; u: LiveUpdate }> = [];
    for (const x of l1Misses) {
      const tw = l2[keyOf(x)];
      if (tw) liveTakeCache.set(keyOf(x), { at: now, tk: tw });
      else llmMisses.push(x);
    }
    // LLM: updates missing from both caches. Write back to L1 + L2.
    if (llmMisses.length) {
      const prepared = llmMisses.map((x, i) => ({
        k: `a${i + 1}`,
        id: keyOf(x),
        block: `id: a${i + 1}\nLive blog: ${x.blog.title}\nUpdate: ${x.u.text.slice(0, 2500)}`,
      }));
      const fresh = await runBatch(prepared, LIVE_SYSTEM);
      const toPersist: Array<{ id: string; takeaway: string }> = [];
      for (const x of llmMisses) {
        const id = keyOf(x);
        const tw = fresh[id];
        if (tw) {
          liveTakeCache.set(id, { at: now, tk: tw });
          toPersist.push({ id, takeaway: tw });
        }
      }
      if (toPersist.length) {
        try {
          await putNewsTakeaways(toPersist);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  return flat.map((x) => {
    const id = keyOf(x); // composite: parent blog id + update block id (unique per update)
    return {
      id,
      title: x.blog.title, // keeps the "– live" suffix so the card shows the LIVE chip
      trailText: null,
      section: x.blog.section,
      url: `${x.blog.url}#block-${x.u.blockId}`,
      published: x.u.published || x.blog.published,
      byline: x.blog.byline, // client currentAuthor() extracts the "(now)" author
      image: x.u.image || null, // this update's OWN image, else null → card shows the Guardian logo
      imageAlt: null,
      takeaway: liveTakeCache.get(id)?.tk || snippet(x.u.text), // memoized LLM takeaway, else the update's own first sentence
    };
  });
}
