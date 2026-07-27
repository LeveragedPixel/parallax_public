// functions/api/connections.js
// GET  /api/connections           -> provider status + Venice credit balance
// POST /api/connections {provider,key} -> save a provider API key (server-side, KV)
// Keys are stored in KV and never returned to the browser.

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";
import { getKeys, saveKey, veniceBalance, artcraftBalance } from "./_providers.js";

const PROVIDERS = ["venice", "artcraft", "anthropic", "openai", "anthropic_admin", "openai_admin"];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
async function authUser(context) {
  const token = tokenFrom(context.request);
  if (!(await verifyToken(token, context.env.SESSION_SECRET))) return null;
  return userFromToken(token);
}

export async function onRequestGet(context) {
  const user = await authUser(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  const keys = await getKeys(context.env, user);

  let veniceBal = null;
  if (keys.venice) {
    try { veniceBal = await veniceBalance(keys.venice); } catch { veniceBal = { usd: null, error: true }; }
  }
  let artcraftBal = null;
  if (keys.artcraft && keys.artcraftBase) {
    try { artcraftBal = await artcraftBalance(keys.artcraftBase, keys.artcraft); } catch { artcraftBal = { error: true }; }
  }
  return json({
    ok: true,
    providers: {
      anthropic: { connected: !!keys.anthropic, admin: !!keys.anthropicAdmin },
      openai: { connected: !!keys.openai, admin: !!keys.openaiAdmin },
      venice: { connected: !!keys.venice, balance: veniceBal },
      artcraft: { connected: !!keys.artcraft, baseSet: !!keys.artcraftBase, balance: artcraftBal },
    },
  });
}

export async function onRequestPost(context) {
  const user = await authUser(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!context.env.PARALLAX_KV) return json({ error: "KV not configured" }, 500);

  let body;
  try { body = await context.request.json(); } catch { return json({ error: "bad body" }, 400); }
  const provider = body && body.provider;
  const key = (body && body.key || "").trim();
  const base = (body && body.base || "").trim();
  if (!PROVIDERS.includes(provider)) return json({ error: "unknown provider" }, 400);
  if (!key && !base) return json({ error: "key or base required" }, 400);

  try {
    if (key) await saveKey(context.env, user, provider, key);
    if (provider === "artcraft" && base) await saveKey(context.env, user, "artcraft_base", base);
  } catch (err) {
    return json({ error: err.message || "save failed" }, 500);
  }
  return json({ ok: true, provider });
}
