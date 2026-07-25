// functions/api/_gallery.js — the on-site media store (gallery-first; Google Drive later).
// Index:  "media_index:<user>" -> [{id,type,provider,prompt,createdAt,meta}]
// Item:   "media:<user>:<id>"   -> {dataUrl?|url?, ...}
// Stored so generated images/videos can be referenced any time from the deck.

function newId() {
  const a = crypto.getRandomValues(new Uint8Array(8));
  return "m_" + [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadIndex(env, user) {
  if (!env.PARALLAX_KV) return [];
  const raw = await env.PARALLAX_KV.get("media_index:" + user);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

export async function addMedia(env, user, item) {
  if (!env.PARALLAX_KV) return null;
  const id = newId();
  const entry = {
    id,
    type: item.type || "image",
    provider: item.provider || "venice",
    prompt: (item.prompt || "").slice(0, 400),
    projectId: item.projectId || null,   // groups media into per-project folders (null = manual/unsorted)
    folder: item.folder || null,         // optional user-created folder id (overrides project grouping in the UI)
    createdAt: Date.now(),
    meta: item.meta || {},
  };
  await env.PARALLAX_KV.put("media:" + user + ":" + id, JSON.stringify({ dataUrl: item.dataUrl || null, url: item.url || null }));
  const index = await loadIndex(env, user);
  index.unshift(entry);
  // keep the index bounded; item blobs live in their own keys
  await env.PARALLAX_KV.put("media_index:" + user, JSON.stringify(index.slice(0, 500)));
  return entry;
}

export async function getMedia(env, user, id) {
  if (!env.PARALLAX_KV) return null;
  const raw = await env.PARALLAX_KV.get("media:" + user + ":" + id);
  return raw ? JSON.parse(raw) : null;
}

export async function removeMedia(env, user, id) {
  if (!env.PARALLAX_KV) return;
  await env.PARALLAX_KV.delete("media:" + user + ":" + id);
  const index = (await loadIndex(env, user)).filter((e) => e.id !== id);
  await env.PARALLAX_KV.put("media_index:" + user, JSON.stringify(index));
}

// ---- user-created folders (custom organization on top of the automatic per-project grouping) ----
export async function loadFolders(env, user) {
  if (!env.PARALLAX_KV) return [];
  const raw = await env.PARALLAX_KV.get("folders:" + user);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}
export async function saveFolders(env, user, folders) {
  if (!env.PARALLAX_KV) return;
  await env.PARALLAX_KV.put("folders:" + user, JSON.stringify((folders || []).slice(0, 100)));
}
// Assign a set of media ids to a folder (folder=null clears them back to auto/unsorted).
export async function setMediaFolder(env, user, ids, folder) {
  if (!env.PARALLAX_KV) return [];
  const set = new Set(ids || []);
  const index = await loadIndex(env, user);
  for (const e of index) { if (set.has(e.id)) e.folder = folder || null; }
  await env.PARALLAX_KV.put("media_index:" + user, JSON.stringify(index));
  return index;
}
