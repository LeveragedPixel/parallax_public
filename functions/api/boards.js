// functions/api/boards.js — Space boards, KV-backed so they follow the account.
// GET    /api/boards            -> { ok, boards: [{id,name,updatedAt}] }  (index)
// GET    /api/boards?id=<id>    -> { ok, id, name, board }                (one board doc)
// POST   /api/boards { id?, name?, board? } -> upsert; creates when id is missing.
//        Rename = POST { id, name } with no board. Returns { ok, id, boards }.
// DELETE /api/boards?id=<id>    -> remove board + index entry. Media referenced by a
//        board lives in the gallery and is never touched here.
// A board doc is layout only: { nodes, edges, pan, zoom, updatedAt } — image/video
// nodes reference gallery ids, so the doc stays small.

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }
const IDX = (u) => `boards:${u}`;
const DOC = (u, id) => `board:${u}:${id}`;

function boardId() {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return "b_" + [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function loadIndex(env, user) {
  const raw = await env.PARALLAX_KV.get(IDX(user));
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}
async function saveIndex(env, user, idx) {
  await env.PARALLAX_KV.put(IDX(user), JSON.stringify(idx.slice(0, 100)));
}
// Bound a board doc: layout + ids + node text only; inline media blobs are stripped
// (they belong in the gallery) so a doc can never blow past KV limits.
function boundBoard(b) {
  const doc = { pan: b && b.pan, zoom: b && b.zoom, updatedAt: Number(b && b.updatedAt) || Date.now() };
  doc.nodes = (Array.isArray(b && b.nodes) ? b.nodes : []).slice(0, 500).map((n) => {
    const { dataUrl, busy, ...keep } = n || {};
    if (keep.src && /^data:/.test(keep.src)) delete keep.src;
    if (typeof keep.reply === "string" && keep.reply.length > 20000) keep.reply = keep.reply.slice(0, 20000);
    return keep;
  });
  doc.edges = (Array.isArray(b && b.edges) ? b.edges : []).slice(0, 1000);
  return doc;
}

async function auth(context) {
  const token = tokenFrom(context.request);
  if (!(await verifyToken(token, context.env.SESSION_SECRET))) return null;
  return userFromToken(token);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const user = await auth(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!env.PARALLAX_KV) return json({ ok: true, boards: [] });
  let id = ""; try { id = new URL(request.url).searchParams.get("id") || ""; } catch {}
  if (!id) return json({ ok: true, boards: await loadIndex(env, user) });
  const raw = await env.PARALLAX_KV.get(DOC(user, id));
  if (!raw) return json({ error: "board not found" }, 404);
  let board = null; try { board = JSON.parse(raw); } catch {}
  const meta = (await loadIndex(env, user)).find((b) => b.id === id);
  return json({ ok: true, id, name: (meta && meta.name) || "Board", board });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const user = await auth(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!env.PARALLAX_KV) return json({ error: "KV not configured" }, 500);
  const clen = Number(request.headers.get("content-length") || 0);
  if (clen > 6000000) return json({ error: "board payload too large" }, 413);
  let body; try { body = await request.json(); } catch { return json({ error: "bad body" }, 400); }

  const idx = await loadIndex(env, user);
  let id = body.id || "";
  let entry = id ? idx.find((b) => b.id === id) : null;
  if (id && !entry) {
    // unknown id from a stale client — recreate the index entry rather than failing
    entry = { id, name: (body.name || "Board").slice(0, 60), createdAt: Date.now() };
    idx.push(entry);
  }
  if (!id) {
    if (idx.length >= 100) return json({ error: "too many boards" }, 400);
    id = boardId();
    entry = { id, name: (body.name || "Board " + (idx.length + 1)).slice(0, 60), createdAt: Date.now() };
    idx.push(entry);
  }
  if (body.name) entry.name = String(body.name).slice(0, 60);
  entry.updatedAt = Date.now();
  if (body.board) {
    const doc = boundBoard(body.board);
    const str = JSON.stringify(doc);
    if (str.length > 4000000) return json({ error: "board too large — remove some nodes" }, 413);
    await env.PARALLAX_KV.put(DOC(user, id), str);
  }
  await saveIndex(env, user, idx);
  return json({ ok: true, id, boards: idx });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const user = await auth(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  let id = ""; try { id = new URL(request.url).searchParams.get("id") || ""; } catch {}
  if (!id) return json({ error: "id required" }, 400);
  if (env.PARALLAX_KV) {
    await env.PARALLAX_KV.delete(DOC(user, id));
    const idx = (await loadIndex(env, user)).filter((b) => b.id !== id);
    await saveIndex(env, user, idx);
    return json({ ok: true, boards: idx });
  }
  return json({ ok: true, boards: [] });
}
