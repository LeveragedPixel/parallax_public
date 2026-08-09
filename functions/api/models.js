// functions/api/models.js
// GET /api/models?provider=claude|gpt|venice|artcraft[&type=image|video]
// Detects the models each connected key can use — for the chat lanes AND for the
// media generators (so the prompter can show real provider options).

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";
import { getKeys, veniceModels, artcraftModels, VENICE_SEEDANCE_VIDEO } from "./_providers.js";

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
    if (provider === "gpt") return json({ ok: true, provider, type, models: await listGPT(keys.openai, type === "image" && hasTypeParam(request)) });
    if (provider === "venice") {
      // v66: images are unlocked again — Venice's own image catalogue (Nano Banana Pro and
      // the rest) is served straight from its /models list. The spend safeguard is the
      // Generate confirmation, not an empty picker.
      if (type === "image") {
        if (!keys.venice) return json({ ok: true, provider, type, models: [], note: "Venice not connected — add your key in Connections" });
        try { return json({ ok: true, provider, type, models: await veniceModels(keys.venice, "image") }); }
        catch (e) { return json({ ok: true, provider, type, models: [], note: "couldn't reach Venice's image model list: " + (e.message || "unknown") }); }
      }
      // The Seedance catalog is a constant, so offer it even with no key / a failed
      // probe — an unconfigured provider should never collapse the picker to "default".
      if (!keys.venice) return json({ ok: true, provider, type, models: VENICE_SEEDANCE_VIDEO, note: "Venice not connected — add your key in Connections to render" });
      try { return json({ ok: true, provider, type, models: await veniceModels(keys.venice, type) }); }
      catch { return json({ ok: true, provider, type, models: VENICE_SEEDANCE_VIDEO, note: "couldn't reach Venice's model list — showing the Seedance catalog" }); }
    }
    // v66: ArtCraft's image catalogue (Nano Banana Pro, Seedream, FLUX…) is a constant, so
    // it lists even when the key is missing — the picker should never collapse to "default".
    if (provider === "artcraft") return json({ ok: true, provider, type, models: artcraftModels(type) });
    return json({ error: "unknown provider" }, 400);
  } catch (err) {
    return json({ error: err.message || "model detection failed" });
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

function hasTypeParam(request) {
  try { return new URL(request.url).searchParams.has("type"); } catch { return false; }
}
async function listGPT(key, imageModels) {
  if (!key) throw new Error("OpenAI key not configured");
  const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const d = await res.json();
  // Image mode: the gpt-image family only (Images API). Chat mode: the usual filter.
  const isImage = (id) => /^gpt-image/i.test(id);
  const isChat = (id) =>
    /^(gpt-|o[0-9]|chatgpt)/i.test(id) &&
    !/(embedding|whisper|tts|audio|realtime|image|dall|moderation|search|transcribe|instruct|batch)/i.test(id);
  return (d.data || [])
    .filter((m) => (imageModels ? isImage(m.id || "") : isChat(m.id || "")))
    .map((m) => ({ id: m.id, label: m.id, created: m.created || 0 }))
    .sort((a, b) => (b.created || 0) - (a.created || 0));
}
