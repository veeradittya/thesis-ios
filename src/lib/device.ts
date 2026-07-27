// Best-effort "make & model" of the device a user is on, parsed from the User-Agent string.
// Browsers don't expose the exact phone model on iOS (Apple only says "iPhone"), so for Apple
// devices we report the family + iOS version + browser; Android UAs usually carry the real model
// code (e.g. "SM-S911B"), which we surface. Runs server-side in the activity route.

function browser(ua: string): string {
  if (/EdgA?|Edg\//.test(ua)) return "Edge";
  if (/CriOS/.test(ua)) return "Chrome";
  if (/FxiOS|Firefox/.test(ua)) return "Firefox";
  if (/OPiOS|OPR\//.test(ua)) return "Opera";
  if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return "Chrome";
  if (/Version\/.*Safari/.test(ua) || /Safari/.test(ua)) return "Safari";
  return "";
}

// Home-screen PWAs report the standalone display mode; nice to know, but the UA alone can't tell,
// so we only note the browser here.
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const parts: string[] = [];
  const br = browser(ua);

  const iOS = ua.match(/OS (\d+)[_.](\d+)/); // "iPhone OS 17_4" → 17.4
  if (/iPhone/.test(ua)) {
    parts.push("iPhone");
    if (iOS) parts.push(`iOS ${iOS[1]}.${iOS[2]}`);
  } else if (/iPad/.test(ua)) {
    parts.push("iPad");
    if (iOS) parts.push(`iPadOS ${iOS[1]}.${iOS[2]}`);
  } else if (/Android/.test(ua)) {
    const ver = ua.match(/Android (\d+(?:\.\d+)?)/);
    // Model sits between "; <Android ver>; " and the next "Build" or ")".
    const model = ua.match(/Android [^;]+;\s*([^;)]+?)(?:\s+Build\/|\)|;)/);
    const m = model ? model[1].trim() : "";
    parts.push(m && m.toLowerCase() !== "k" ? m : "Android phone"); // Chrome freezes some models to "K"
    if (ver) parts.push(`Android ${ver[1]}`);
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    parts.push("Mac");
  } else if (/Windows NT/.test(ua)) {
    parts.push("Windows PC");
  } else if (/Linux/.test(ua)) {
    parts.push("Linux");
  } else {
    parts.push("Unknown device");
  }

  if (br) parts.push(br);
  return parts.join(" · ");
}
