// functions/api/skills.js
// GET  /api/skills          -> browse the bundled Skills Library (metadata only)
// POST /api/skills {skillId} -> add a skill: clone it into the user's Projects
// The heavy instructions/reference text stays server-side in _catalog.js; the browse
// list ships only names + descriptions.

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";
import { loadProjects, saveProjects } from "./_projects.js";
import { CATALOG } from "./_catalog.js";
import { mergedCatalog, loadUserSkills, saveUserSkills, sanitizeSkill } from "./_skills.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
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

  const catalog = await mergedCatalog(context.env, user); // bundled + this user's custom skills

  // ?id=<skill> returns the FULL entry (instructions + reference) for view/edit.
  let id = "";
  try { id = new URL(context.request.url).searchParams.get("id") || ""; } catch {}
  if (id) {
    const s = catalog.find((c) => c.id === id);
    if (!s) return json({ error: "not found" }, 404);
    return json({ ok: true, skill: s });
  }

  const skills = catalog.map((c) => ({
    id: c.id,
    name: c.name,
    author: c.author,
    type: c.type,
    subtype: c.subtype,
    status: c.status,
    note: c.note,
    description: c.description,
    refs: (c.reference || []).length,
    custom: !!c.custom,
  }));
  return json({ ok: true, skills });
}

export async function onRequestPost(context) {
  const user = await authUser(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!context.env.PARALLAX_KV) return json({ error: "KV not configured" }, 500);

  const clen = Number(context.request.headers.get("content-length") || 0);
  if (clen > 5000000) return json({ error: "skill too large" }, 413);
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "bad body" }, 400);
  }

  // Create a custom skill -> store it in the user's skill list.
  if (body && body.create) {
    const skill = sanitizeSkill(body.create);
    if (!skill) return json({ error: "skill name required" }, 400);
    const list = await loadUserSkills(context.env, user);
    list.unshift(skill);
    await saveUserSkills(context.env, user, list);
    return json({ ok: true, skill });
  }
  // Delete a custom skill (does not touch projects already created from it).
  if (body && body.deleteSkillId) {
    let list = await loadUserSkills(context.env, user);
    list = list.filter((s) => s.id !== body.deleteSkillId);
    await saveUserSkills(context.env, user, list);
    return json({ ok: true });
  }

  // Otherwise: clone a skill (bundled OR custom) into a new project.
  const catalog = await mergedCatalog(context.env, user);
  const entry = catalog.find((c) => c.id === (body && body.skillId));
  if (!entry) return json({ error: "unknown skill" }, 404);

  const now = Date.now();
  const project = {
    id: newId(),
    name: entry.name,
    type: entry.type,
    subtype: entry.subtype || null,
    author: entry.author, // author
    fromSkill: entry.id,
    instructions: entry.instructions,
    reference: entry.reference,
    settings: { ...entry.defaultSettings },
    createdAt: now,
    updatedAt: now,
  };

  const projects = await loadProjects(context.env, user);
  projects.push(project);
  try {
    await saveProjects(context.env, user, projects);
  } catch (err) {
    return json({ error: err.message || "save failed" }, 500);
  }
  return json({ ok: true, project });
}
