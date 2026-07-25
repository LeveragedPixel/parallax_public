// functions/api/balances.js — user-entered API credit balances (KV-backed).
// Anthropic and OpenAI expose NO "remaining balance" endpoint to API keys (Venice does),
// so the studio counts down from a balance the user sets, decremented client-side from
// real token usage and synced here so it follows the account.
// GET  /api/balances                      -> { ok, balances: { anthropic:{usd,setAt}, openai:{...} } }
// POST /api/balances { provider, usd }    -> set the current balance for a provider

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }
const KEY = (u) => `balances:${u}`;

async function load(env, user) {
  if (!env.PARALLAX_KV) return {};
  const raw = await env.PARALLAX_KV.get(KEY(user));
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) return json({ error: "unauthorized" }, 401);
  return json({ ok: true, balances: await load(env, userFromToken(token)) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) return json({ error: "unauthorized" }, 401);
  if (!env.PARALLAX_KV) return json({ error: "KV not configured" }, 500);
  let body; try { body = await request.json(); } catch { return json({ error: "bad body" }, 400); }
  const provider = body && body.provider;
  if (provider !== "anthropic" && provider !== "openai") return json({ error: "provider must be anthropic or openai" }, 400);
  const usd = Number(body.usd);
  const user = userFromToken(token);
  const balances = await load(env, user);
  if (!Number.isFinite(usd)) delete balances[provider];   // clear
  else balances[provider] = { usd: Math.max(0, usd), setAt: Date.now() };
  await env.PARALLAX_KV.put(KEY(user), JSON.stringify(balances));
  return json({ ok: true, balances });
}
