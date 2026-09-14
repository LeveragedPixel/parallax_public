// functions/api/_demo.js — everything that makes a passwordless public demo safe.
//
// Parallax is designed to be deployed by one operator holding the provider keys. Opening
// it to the public without a password creates exactly two ways for a stranger to hurt the
// operator, and both are closed here:
//
//   1. MONEY. getKeys() falls back to the operator's environment keys, so a demo visitor's
//      first image generation would spend the operator's credit, uncapped and unattributable.
//      Demo users get NO environment fallback — they connect their own key, or nothing
//      generates. An operator who WANTS to fund the demo sets DEMO_SHARED_KEYS=on.
//   2. WRITE ACCESS. /api/repo commits to GitHub with the operator's token. Demo users are
//      refused outright, regardless of any other setting.
//
// Isolation is free: every store is already keyed by username ("projects:<user>",
// "gallery:<user>", "keys:<user>"), so minting a fresh username per demo login gives each
// visitor a private workspace with no extra work. That is why a demo login mints a NEW id
// rather than logging everyone in as "demo" — one shared demo account means strangers
// reading and deleting each other's work.

export const DEMO_PREFIX = "demo_";

// Short by design. These workspaces are disposable, and the token IS the account — there is
// no password to recover one with, so a long expiry only accumulates abandoned data.
export const DEMO_TTL_MS = 24 * 60 * 60 * 1000;

export const isDemo = (user) => String(user || "").startsWith(DEMO_PREFIX);

// On unless the operator turns it off, so a fresh clone is useful the moment it deploys.
export const demoEnabled = (env) =>
  String((env && env.DEMO_MODE) ?? "on").trim().toLowerCase() !== "off";

// Off unless the operator opts in. Read this as "I am willing to pay for strangers".
export const demoSharesKeys = (env) =>
  String((env && env.DEMO_SHARED_KEYS) ?? "").trim().toLowerCase() === "on";

export function newDemoUser() {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return DEMO_PREFIX + [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
