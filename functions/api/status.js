// functions/api/status.js — GET /api/status
// Pings each provider with a cheap, short-timeout request so the top bar can show a
// live/down/not-connected dot per provider (Claude · GPT · Venice · ArtCraft).
// A "live" means: key present AND the provider answered OK within the timeout.

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";
import { getKeys } from "./_providers.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

// A single provider probe. Returns {connected, live, note?, usd?}.
async function ping(url, headers, ms) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
    return { ok: res.ok, status: res.status, res };
  } catch (e) {
    return { ok: false, status: 0, err: e.name || e.message || "unreachable" };
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) return json({ error: "unauthorized" }, 401);

  const keys = await getKeys(env, userFromToken(token));

  const checks = {
    claude: keys.anthropic
      ? ping("https://api.anthropic.com/v1/models?limit=1", { "x-api-key": keys.anthropic, "anthropic-version": "2023-06-01" }, 6000).then((r) => ({ connected: true, live: r.ok, note: r.ok ? null : (r.err || "HTTP " + r.status) }))
      : Promise.resolve({ connected: false, live: false }),
    gpt: keys.openai
      ? ping("https://api.openai.com/v1/models", { Authorization: "Bearer " + keys.openai }, 6000).then((r) => ({ connected: true, live: r.ok, note: r.ok ? null : (r.err || "HTTP " + r.status) }))
      : Promise.resolve({ connected: false, live: false }),
    venice: keys.venice
      ? ping("https://api.venice.ai/api/v1/models?type=image", { Authorization: "Bearer " + keys.venice }, 6000).then((r) => {
          const usd = r.res ? r.res.headers.get("x-venice-balance-usd") : null;
          return { connected: true, live: r.ok, usd: usd != null ? Number(usd) : null, note: r.ok ? null : (r.err || "HTTP " + r.status) };
        })
      : Promise.resolve({ connected: false, live: false }),
    artcraft: (keys.artcraft && keys.artcraftBase)
      ? ping(`${keys.artcraftBase}/v1/account/credits`, { Authorization: "Bearer " + keys.artcraft, Accept: "application/json", "User-Agent": "Mozilla/5.0" }, 5000).then((r) => ({ connected: true, live: r.ok, note: r.ok ? null : (r.err === "TimeoutError" ? "no server-side response (parked)" : r.err || "HTTP " + r.status) }))
      : Promise.resolve({ connected: !!keys.artcraft, live: false, note: keys.artcraft && !keys.artcraftBase ? "base URL missing" : null }),
  };

  const [claude, gpt, venice, artcraft] = await Promise.all([checks.claude, checks.gpt, checks.venice, checks.artcraft]);
  return json({ ok: true, providers: { claude, gpt, venice, artcraft } });
}
