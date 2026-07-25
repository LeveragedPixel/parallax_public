// functions/api/models.js
// GET /api/models?provider=claude|gpt|venice|artcraft[&type=image|video]
// Detects the models each connected key can use — for the chat lanes AND for the
// media generators (so the prompter can show real provider options).

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";
import { getKeys, veniceModels, artcraftModels } from "./_providers.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) return json({ error: "unauthorized" }, 401);

  let provider = "claude", type = "image";
  try {
    const u = new URL(request.url);
    provider = u.searchParams.get("provider") || "claude";
    type = u.searchParams.get("type") || "image";
  } catch {}

  const keys = await getKeys(env, userFromToken(token));
  try {
    if (provider === "claude") return json({ ok: true, provider, models: await listClaude(keys.anthropic) });
    if (provider === "gpt") return json({ ok: true, provider, models: await listGPT(keys.openai) });
    if (provider === "venice") {
      if (!keys.venice) return json({ ok: true, provider, models: [], note: "Venice not connected" });
      return json({ ok: true, provider, type, models: await veniceModels(keys.venice, type) });
    }
    if (provider === "artcraft") return json({ ok: true, provider, type, models: artcraftModels(type) });
    return json({ error: "unknown provider" }, 400);
  } catch (err) {
    return json({ error: err.message || "model detection failed" }, 502);
  }
}

async function listClaude(key) {
  if (!key) throw new Error("Claude key not configured");
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const d = await res.json();
  return (d.data || [])
    .filter((m) => (m.id || "").startsWith("claude"))
    .map((m) => ({ id: m.id, label: m.display_name || m.id, created: m.created_at || "" }))
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

async function listGPT(key) {
  if (!key) throw new Error("OpenAI key not configured");
  const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const d = await res.json();
  const isChat = (id) =>
    /^(gpt-|o[0-9]|chatgpt)/i.test(id) &&
    !/(embedding|whisper|tts|audio|realtime|image|dall|moderation|search|transcribe|instruct|batch)/i.test(id);
  return (d.data || [])
    .filter((m) => isChat(m.id || ""))
    .map((m) => ({ id: m.id, label: m.id, created: m.created || 0 }))
    .sort((a, b) => (b.created || 0) - (a.created || 0));
}
