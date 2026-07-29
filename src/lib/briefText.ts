// Single source of truth for turning the Daily Briefing agent's markdown prose
// (Turso `assets.rationale` / `portfolios.memo`) into clean reading-view text.
//
// The agent writes TWO kinds of markdown links, and they must be treated differently:
//   1. inline prose links   — "hit a [record low this week](url), briefly ..."
//        → the anchor IS part of the sentence; keep it, drop only the URL.
//   2. parenthetical cites   — "went well ([Yahoo](url)). Next ..."
//        → the anchor is just a source label; drop the whole "( … )" wrapper.
//
// The old logic deleted EVERY `[text](url)` outright, which gutted sentences whose
// link was prose — e.g. "SpaceX hit a [record low this week](url), briefly ..." rendered
// as "SpaceX hit a, briefly ...". The rule below never deletes an anchor, so that class
// of bug cannot recur regardless of what the agent emits. Full sources stay in the DB;
// only the reading view is stripped.
//
// Both the Brief reading view (BriefReveal) and the monitor card (ThesisMonitorCard)
// route through this one function so the two can never drift.
export function stripCitations(md: string | null | undefined): string {
  return (md ?? "")
    // 1. Parenthetical citation group: " ([Src](url))" or " ([A](url), [B](url))" → removed whole.
    .replace(/\s*\((?:\[[^\]]+\]\([^)\s]+\)(?:\s*,\s*)?)+\)/g, "")
    // 2. Any remaining link → KEEP the anchor text, drop only the URL.
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    // 3. Drop bold markers so "**x**" never leaks through as literal asterisks.
    .replace(/\*\*/g, "")
    // 4. Tidy the whitespace / space-before-punctuation the removals leave behind.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trim();
}
