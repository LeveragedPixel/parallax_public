// functions/api/projects.js
// The Projects CRUD route — the foundation everything else rides on.
//   GET    /api/projects        -> list this user's projects
//   POST   /api/projects        -> upsert a project (body = project object; new if no id)
//   DELETE /api/projects?id=...  -> delete a project
// Auth: same Bearer session token as the other routes. Storage: PARALLAX_KV.

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";
import { loadProjects, saveProjects } from "./_projects.js";

const TYPES = ["chat", "video", "image"];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function authUser(context) {
  const token = tokenFrom(context.request);
  if (!(await verifyToken(token, context.env.SESSION_SECRET))) return null;
  return userFromToken(token);
}

function newId() {
  const a = crypto.getRandomValues(new Uint8Array(8));
  return "proj_" + [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequestGet(context) {
  const user = await authUser(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  const projects = await loadProjects(context.env, user);
  return json({ ok: true, projects });
}

export async function onRequestPost(context) {
  const user = await authUser(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!context.env.PARALLAX_KV) return json({ error: "KV not configured" }, 500);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "bad body" }, 400);
  }
  const p = body || {};
  if (!p.name || !TYPES.includes(p.type)) {
    return json({ error: "name and a valid type (chat|video|image) are required" }, 400);
  }

  const projects = await loadProjects(context.env, user);
  const now = Date.now();
  if (p.id) {
    const i = projects.findIndex((x) => x.id === p.id);
    if (i === -1) return json({ error: "not found" }, 404);
    projects[i] = { ...projects[i], ...p, id: projects[i].id, createdAt: projects[i].createdAt, updatedAt: now };
  } else {
    p.id = newId();
    p.createdAt = now;
    p.updatedAt = now;
    p.reference = Array.isArray(p.reference) ? p.reference : [];
    p.settings = p.settings || {};
    projects.push(p);
  }

  try {
    await saveProjects(context.env, user, projects);
  } catch (err) {
    return json({ error: err.message || "save failed" }, 500);
  }
  const saved = projects.find((x) => x.id === p.id);
  return json({ ok: true, project: saved });
}

export async function onRequestDelete(context) {
  const user = await authUser(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!context.env.PARALLAX_KV) return json({ error: "KV not configured" }, 500);

  let id = "";
  try {
    id = new URL(context.request.url).searchParams.get("id") || "";
  } catch {}
  if (!id) return json({ error: "id required" }, 400);

  const projects = await loadProjects(context.env, user);
  const next = projects.filter((x) => x.id !== id);
  try {
    await saveProjects(context.env, user, next);
  } catch (err) {
    return json({ error: err.message || "save failed" }, 500);
  }
  return json({ ok: true, deleted: id });
}
