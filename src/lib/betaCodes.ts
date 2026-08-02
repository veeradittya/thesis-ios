// Beta access codes — a fixed allowlist for the private beta group, so testers can sign in WITHOUT a
// Google/Apple account. SERVER-ONLY: imported by src/auth.ts and the auth API routes, never by a client
// component, so the codes are never shipped to the browser. A code maps to a STABLE account id
// (beta_<CODE>): re-entering the same code retrieves the same account (portfolio, brief, name).
//
// Managing codes: edit this list. Comparison is case-insensitive and ignores separators/spaces, so a
// tester may type "ths xxxx xxxx", "THSXXXXXXXX", etc.

const CODES = [
  "THS-WDKW-9XH8",
  "THS-E2VD-P7TN",
  "THS-5FP6-DNFJ",
  "THS-SUJT-6B6K",
  "THS-9PCJ-C6CN",
  "THS-9Z4E-NYUA",
  "THS-ADDV-YJ7K",
  "THS-C2UY-P2PY",
  "THS-QQWY-5G2D",
  "THS-3X9C-YFZY",
  "THS-5XF8-U5KR",
  "THS-7F8Q-7V2S",
  "THS-JUDV-KCJ5",
  "THS-2G47-ZBRW",
  "THS-SXBR-MGCM",
  "THS-NU3D-DJ5K",
  "THS-N3N7-SWDE",
  "THS-BSTH-44VK",
  "THS-3FKT-UJW4",
  "THS-QWFJ-6PUP",
  "THS-M6KR-42D3",
  "THS-PRVS-67K9",
  "THS-RCX6-ESQ3",
  "THS-RS2U-4RYQ",
  "THS-PS4H-U2B6",
  "THS-RVA4-62KM",
  "THS-3ZPM-E832",
  "THS-37DE-Z9T6",
  "THS-NYDN-2ZGY",
  "THS-V5S2-WNGP",
] as const;

// Normalize for comparison: uppercase, strip everything but A-Z/0-9.
function norm(s: string): string {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const VALID = new Set(CODES.map(norm));

export function isValidBetaCode(code: string): boolean {
  return VALID.has(norm(code));
}

// Stable per-code account id (Turso user_id + JWT sub). Same code -> same account, on any device.
export function betaUserId(code: string): string {
  return `beta_${norm(code)}`;
}

export const BETA_CODES: readonly string[] = CODES;
