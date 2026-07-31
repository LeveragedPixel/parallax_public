// functions/api/threads.js — chat THREADS (KV-backed).
//
// A thread is one conversation on one topic. It is NOT a project:
//   • thread  = a conversation you can rename, delete, and keep forever
//   • project = a container of rules/skills/reference; a thread may belong to one,
//               and then every message in that thread inherits the project's context
// A thread's messages live in /api/conversations under the thread's id, so legacy
// ids ("__raw", or an old project id) keep working as thread ids with no migration.
//
// GET    /api/threads                          -> { ok, threads: [...] }
// POST   /api/threads { title?, projectId? }    -> create
// POST   /api/threads { id, title?, projectId? }-> rename / move (projectId:null detaches)
// DELETE /api/threads?id=<id>                   -> delete thread + its conversation

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }
const KEY = (u) => `threads:${u}`;
const CONVO = (u, id) => `convo:${u}:${id}`;
const newId = () => "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function auth(context) {
  const token = tokenFrom(context.request);
  if (!(await verifyToken(token, context.env.SESSION_SECRET))) return null;
  return userFromToken(token);
}
async function load(env, user) {
  if (!env.PARALLAX_KV) return [];
  const raw = await env.PARALLAX_KV.get(KEY(user));
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}
async function save(env, user, list) {
  await env.PARALLAX_KV.put(KEY(user), JSON.stringify(list.slice(0, 500)));
}
const clean = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);

export async function onRequestGet(context) {
  const user = await auth(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  return json({ ok: true, threads: await load(context.env, user) });
}

export async function onRequestPost(context) {
  const { env } = context;
  const user = await auth(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!env.PARALLAX_KV) return json({ error: "KV not configured" }, 500);
  let body; try { body = await context.request.json(); } catch { return json({ error: "bad body" }, 400); }

  const list = await load(env, user);

  // update an existing thread (rename and/or move between projects)
  if (body.id) {
    const t = list.find((x) => x.id === body.id);
    if (!t) return json({ error: "thread not found" }, 404);
    if (body.title != null) t.title = clean(body.title, 80) || t.title;
    if ("projectId" in body) t.projectId = body.projectId ? clean(body.projectId, 60) : null;
    t.updatedAt = Date.now();
    await save(env, user, list);
    return json({ ok: true, thread: t, threads: list });
  }

  if (list.length >= 500) return json({ error: "too many threads — delete a few first" }, 400);
  const t = {
    id: body.forceId ? clean(body.forceId, 60) : newId(),
    title: clean(body.title, 80) || "New chat",
    projectId: body.projectId ? clean(body.projectId, 60) : null,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  if (list.some((x) => x.id === t.id)) return json({ ok: true, thread: list.find((x) => x.id === t.id), threads: list });
  list.unshift(t);
  await save(env, user, list);
  return json({ ok: true, thread: t, threads: list });
}

export async function onRequestDelete(context) {
  const { env } = context;
  const user = await auth(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  const id = new URL(context.request.url).searchParams.get("id");
  if (!id) return json({ error: "id required" }, 400);
  const list = (await load(env, user)).filter((t) => t.id !== id);
  await save(env, user, list);
  try { await env.PARALLAX_KV.delete(CONVO(user, id)); } catch {}
  return json({ ok: true, threads: list });
}
