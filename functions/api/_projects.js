// functions/api/_projects.js
// The Projects engine's storage + system-prompt composition.
//
// A Project is the foundation of Parallax 2.0. Every project stores:
//   { id, name, type: "chat"|"video"|"image", instructions, reference[], settings, createdAt, updatedAt }
// where `instructions` is the tuned prompt logic (the web-native replacement for a
// Claude Code skill) and `reference[]` is optional supporting material
// ({ kind, title, body }). Opening a project makes the tool BECOME that mode; the
// backend injects composeSystem(project) as the system prompt of its Claude calls.
//
// Storage: Cloudflare KV binding PARALLAX_KV, key "projects:<user>" -> JSON array.

export async function loadProjects(env, user) {
  if (!env.PARALLAX_KV) return [];
  const raw = await env.PARALLAX_KV.get("projects:" + user);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function saveProjects(env, user, projects) {
  if (!env.PARALLAX_KV) throw new Error("KV not configured");
  const str = JSON.stringify(projects);
  if (str.length > 2000000) throw new Error("projects payload too large");
  await env.PARALLAX_KV.put("projects:" + user, str);
}

export async function loadProject(env, user, id) {
  if (!id) return null;
  const all = await loadProjects(env, user);
  return all.find((p) => p.id === id) || null;
}

// Build the system prompt for a project: its tuned instructions, any additional skills
// attached to the project (each folded in as its own labelled section), then any reference
// material. This is the single injection point that turns a generic Claude call into
// "this project's mode." `catalog` is the skills CATALOG (passed by the caller so this
// module stays free of the heavy _catalog import); attachedSkills is an array of skill ids.
export function composeSystem(project, catalog) {
  if (!project) return "";
  let sys = (project.instructions || "").trim();

  // Fold in each attached skill's instructions (+ its own reference material).
  const attached = Array.isArray(project.attachedSkills) ? project.attachedSkills : [];
  if (attached.length && Array.isArray(catalog)) {
    for (const sid of attached) {
      const s = catalog.find((c) => c.id === sid);
      if (!s) continue;
      sys += `\n\n# Skill: ${s.name}${s.author ? " (" + s.author + ")" : ""}\n${(s.instructions || "").trim()}`;
      const srefs = Array.isArray(s.reference) ? s.reference.filter((r) => r && r.body) : [];
      for (const r of srefs) sys += `\n\n## ${s.name} — ${r.title || r.kind || "reference"}\n${r.body}`;
    }
  }

  const refs = Array.isArray(project.reference) ? project.reference : [];
  const usable = refs.filter((r) => r && r.body);
  if (usable.length) {
    sys += "\n\n# Reference material\n";
    for (const r of usable) {
      sys += `\n## ${r.title || r.kind || "reference"}\n${r.body}\n`;
    }
  }
  return sys.trim();
}
