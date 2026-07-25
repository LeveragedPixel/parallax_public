// functions/api/conversations.js — persistent chat threads, one per project (KV-backed).
// GET  /api/conversations?projectId=<id>   -> { ok, messages: [...] }
// POST /api/conversations { projectId, messages } -> save the thread (bounded)
// DELETE /api/conversations?projectId=<id>  -> clear the thread
// Turns look like { who:"user"|"claude"|"gpt", text, images?:[{media_type,data}], thumbs?:[dataUrl] }.

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }
const KEY = (u, p) => `convo:${u}:${p}`;

// Keep threads small enough for KV + fast reloads: cap turns, and shed old image blobs
// (text is always preserved) until the serialized thread is comfortably under the limit.
function boundThread(msgs) {
  let arr = Array.isArray(msgs) ? msgs.slice(-200) : [];
  const size = () => JSON.stringify(arr).length;
  const LIMIT = 4000000;
  for (let i = 0; i < arr.length && size() > LIMIT; i++) {
    const t = arr[i];
    if (t && ((t.images && t.images.length) || (t.thumbs && t.thumbs.length))) {
      arr[i] = { who: t.who, text: t.text || "[image]" };
    }
  }
  if (size() > 20000000) arr = arr.slice(-40).map((t) => ({ who: t.who, text: t.text || "" }));
  return arr;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) return json({ error: "unauthorized" }, 401);
  if (!env.PARALLAX_KV) return json({ ok: true, messages: [] });
  const user = userFromToken(token);
  let pid = ""; try { pid = new URL(request.url).searchParams.get("projectId") || ""; } catch {}
  if (!pid) return json({ error: "projectId required" }, 400);
  const raw = await env.PARALLAX_KV.get(KEY(user, pid));
  let messages = []; if (raw) { try { messages = JSON.parse(raw) || []; } catch {} }
  return json({ ok: true, messages });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) return json({ error: "unauthorized" }, 401);
  const clen = Number(request.headers.get("content-length") || 0);
  if (clen > 15000000) return json({ error: "conversation payload too large" }, 413);
  if (!env.PARALLAX_KV) return json({ ok: true, note: "KV not configured" });
  const user = userFromToken(token);
  let body; try { body = await request.json(); } catch { return json({ error: "bad body" }, 400); }
  const pid = body && body.projectId;
  if (!pid) return json({ error: "projectId required" }, 400);
  const bounded = boundThread(body.messages);
  await env.PARALLAX_KV.put(KEY(user, pid), JSON.stringify(bounded));
  return json({ ok: true, count: bounded.length });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) return json({ error: "unauthorized" }, 401);
  const user = userFromToken(token);
  let pid = ""; try { pid = new URL(request.url).searchParams.get("projectId") || ""; } catch {}
  if (pid && env.PARALLAX_KV) await env.PARALLAX_KV.delete(KEY(user, pid));
  return json({ ok: true });
}
