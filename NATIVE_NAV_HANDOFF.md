# Native navbar rework — handoff note (for the Claude building the iOS app)

The **web** Dashboard sub-navigation changed. The native WKWebView shell renders its **own** glass
bottom-nav + Dashboard slider and drives/reads the web tab state over the JS bridge, so the native
**Dashboard slider must be reworked to match**. This note is the exact contract.

## What the sub-nav is now

Dashboard sub-tabs (in order): **`Hivemind · News · Allocation · Prediction Markets`**

- **Hivemind is the default** sub-tab.
- **Allocation** is the portfolio modern-portfolio-theory page (allocation ring, efficient frontier,
  per-asset risk/return, correlations). It was previously labeled "Overview" — only the **label** changed;
  its bridge value is still **`overview`** (see below).
- There is **no Chat tab** (the AI chat was split into a separate feature/branch and is not in this build).

The top-level nav is **unchanged**: `Brief · Dashboard · Portfolio · Account`.

## The native slider should show these 4 segments

```
Hivemind   |   News   |   Allocation   |   Prediction Markets
(default)
```

## Bridge contract (exact strings)

The web ↔ native bridge keys the Dashboard sub-tab off string values. Note the **label vs value**
difference for Allocation: the segment shows "Allocation" but its bridge value is `overview`.

| Segment (label)      | bridge value |
|----------------------|--------------|
| Hivemind             | `hivemind`   |
| News                 | `news`       |
| Allocation           | `overview`   |
| Prediction Markets   | `markets`    |

### Outbound — web tells native which sub-tab is active
The web calls, on every tab change:
```js
window.webkit.messageHandlers.thesisNav.postMessage({ tab, dashTab })
```
- `tab` ∈ `"brief" | "dashboard" | "portfolio" | "account"` (unchanged)
- `dashTab` ∈ **`"hivemind" | "news" | "overview" | "markets"`** — position the slider from this
  (map `overview` → the Allocation segment).

### Inbound — native drives the web sub-tab (no reload)
```js
window.__thesisSetTab(tab)        // top nav: "brief" | "dashboard" | "portfolio" | "account"  (unchanged)
window.__thesisSetDashTab(sub)    // Dashboard sub-tab
```
`__thesisSetDashTab(sub)` accepts these `sub` values → maps to:
| `sub` value            | selects            |
|------------------------|--------------------|
| `"hivemind"`           | Hivemind           |
| `"analyst"` (legacy)   | Hivemind           |
| `"news"`               | News               |
| `"overview"`           | Allocation         |
| `"markets"`            | Prediction Markets |

Send `"hivemind"`, `"news"`, `"overview"`, or `"markets"` for the four segments. (`"chat"` is no longer a
valid value; if a previous build sent it, drop it.)

### Deep link (unchanged mechanism)
`?view=brief|dashboard|portfolio` still switches the top tab on load.
`?dash=` accepts: `hivemind`, `news`, `overview`, `markets` (and legacy `analyst` → Hivemind).

## Do NOT break (existing native contracts, all unchanged)
- Push token bridge: `window.__thesisRegisterPushToken(token, 'ios')`; deep link `?view=brief`; alert body
  "Your brief for today is ready to view." with `view: "brief"`.
- Native sign-in bridges: `window.__thesisNativeGoogleSignIn(idToken)`, `window.__thesisNativeAppleSignIn({…})`,
  and the outbound `thesisGoogleSignIn` / `thesisAppleSignIn` message handlers.
- `window.__thesisNativeChrome === true` still gates the native-chrome layout.

## Summary of native work
1. Set the Dashboard slider to 4 segments: **Hivemind (default) · News · Allocation · Prediction Markets**.
2. Emit `"hivemind" | "news" | "overview" | "markets"` via `__thesisSetDashTab(...)` when a segment is tapped
   (remember: the Allocation segment sends `"overview"`).
3. When the web reports `dashTab`, position the slider (map `overview` → Allocation). Remove any old `chat`
   segment/handling.
