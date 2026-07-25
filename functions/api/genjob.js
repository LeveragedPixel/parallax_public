// functions/api/genjob.js — GET /api/genjob?provider=artcraft&job=<token>&type=image|video
// Polls an async ArtCraft generation job; when complete, stores the result in the gallery.

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";
import { getKeys, artcraftJob } from "./_providers.js";
import { addMedia } from "./_gallery.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) return json({ error: "unauthorized" }, 401);

  let provider = "artcraft", job = "", type = "image";
  try {
    const u = new URL(request.url);
    provider = u.searchParams.get("provider") || "artcraft";
    job = u.searchParams.get("job") || "";
    type = u.searchParams.get("type") || "image";
  } catch {}
  if (!job) return json({ error: "job required" }, 400);

  const user = userFromToken(token);
  const keys = await getKeys(env, user);
  if (provider !== "artcraft") return json({ error: "unsupported provider" }, 400);
  if (!keys.artcraft || !keys.artcraftBase) return json({ error: "ArtCraft not connected" });

  try {
    const r = await artcraftJob(keys.artcraftBase, keys.artcraft, job);
    let mediaId = null;
    if (r.done && r.url) {
      const entry = await addMedia(env, user, { type, provider: "artcraft", url: r.url, prompt: "", meta: { job } });
      mediaId = entry ? entry.id : null;
    }
    return json({ ok: true, status: r.status, done: r.done, failed: r.failed, url: r.url, mediaId });
  } catch (err) {
    return json({ error: "job poll failed: " + (err.message || "unknown") });
  }
}
