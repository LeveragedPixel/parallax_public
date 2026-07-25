// functions/api/sessions.js
// GET  /api/sessions  -> load this user's saved transcript/session state
// POST /api/sessions  -> save it
// Per-user blob in KV (key "sessions:<user>"). Kept from v1 for chat transcript
// persistence across refreshes; the client owns the shape.

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env.PARALLAX_KV) return json({ error: "KV not configured" }, 500);
  const key = "sessions:" + userFromToken(token);
  const data = await env.PARALLAX_KV.get(key);
  return json({ ok: true, data: data ? JSON.parse(data) : null });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env.PARALLAX_KV) return json({ error: "KV not configured" }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad body" }, 400);
  }
  const key = "sessions:" + userFromToken(token);
  const str = JSON.stringify(body);
  if (str.length > 2000000) {
    return json({ error: "payload too large" }, 413);
  }
  await env.PARALLAX_KV.put(key, str);
  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
