// functions/api/_skills.js — user-created ("custom") skills, stored in KV and merged with the
// bundled CATALOG. A skill is the same shape as a catalog entry, so it clones into a project and
// resolves in attachedSkills exactly like the built-in ones.

import { CATALOG } from "./_catalog.js";

export function newSkillId() {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return "usk_" + [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadUserSkills(env, user) {
  if (!env.PARALLAX_KV) return [];
  const raw = await env.PARALLAX_KV.get("skills:" + user);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

export async function saveUserSkills(env, user, skills) {
  if (!env.PARALLAX_KV) return;
  await env.PARALLAX_KV.put("skills:" + user, JSON.stringify((skills || []).slice(0, 200)));
}

// The full list callers resolve attachedSkills against: bundled catalog + this user's own skills.
// Never throws — a KV hiccup just yields the catalog, so chat/image/video keep working.
export async function mergedCatalog(env, user) {
  try { return [...CATALOG, ...(await loadUserSkills(env, user))]; } catch { return [...CATALOG]; }
}

// Sanitize a user-submitted skill into a safe, bounded catalog-shaped entry.
export function sanitizeSkill(input) {
  const s = input || {};
  const name = String(s.name || "").trim();
  if (!name) return null;
  const type = ["chat", "image", "video"].includes(s.type) ? s.type : "chat";
  const reference = Array.isArray(s.reference)
    ? s.reference.filter((r) => r && r.title).map((r) => ({ title: String(r.title).slice(0, 120), body: String(r.body || "").slice(0, 20000) })).slice(0, 10)
    : [];
  return {
    id: newSkillId(),
    name: name.slice(0, 80),
    author: (String(s.author || "").trim() || "you").slice(0, 40),
    type,
    subtype: (String(s.subtype || "").trim() || null),
    status: "ready",
    custom: true,
    note: "",
    description: String(s.description || "").slice(0, 600),
    instructions: String(s.instructions || "").slice(0, 20000),
    reference,
    defaultSettings: (s.defaultSettings && typeof s.defaultSettings === "object") ? s.defaultSettings : {},
  };
}
