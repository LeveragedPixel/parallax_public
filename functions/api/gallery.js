// functions/api/gallery.js
// GET    /api/gallery         -> list stored media (metadata index)
// GET    /api/gallery?id=...  -> fetch one media item (dataUrl / url)
// DELETE /api/gallery?id=...  -> remove a media item
// The on-site media store so generated images/videos are referenceable any time.

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";
import { loadIndex, getMedia, removeMedia, addMedia, loadFolders, saveFolders, setMediaFolder } from "./_gallery.js";

function folderId() {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return "f_" + [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
async function authUser(context) {
  const token = tokenFrom(context.request);
  if (!(await verifyToken(token, context.env.SESSION_SECRET))) return null;
  return userFromToken(token);
}

export async function onRequestGet(context) {
  const user = await authUser(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  let id = "";
  try { id = new URL(context.request.url).searchParams.get("id") || ""; } catch {}
  if (id) {
    const item = await getMedia(context.env, user, id);
    if (!item) return json({ error: "not found" }, 404);
    return json({ ok: true, id, ...item });
  }
  return json({ ok: true, media: await loadIndex(context.env, user), folders: await loadFolders(context.env, user) });
}

// POST /api/gallery  { dataUrl, name } -> manually add a reference image/video.
export async function onRequestPost(context) {
  const user = await authUser(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!context.env.PARALLAX_KV) return json({ error: "KV not configured" }, 500);
  let body;
  try { body = await context.request.json(); } catch { return json({ error: "bad body" }, 400); }

  // ---- folder management + moving media (action-based; no dataUrl) ----
  if (body && body.action) {
    const env = context.env;
    if (body.action === "folders.create") {
      const name = (body.name || "").trim();
      if (!name) return json({ error: "folder name required" }, 400);
      const folders = await loadFolders(env, user);
      if (folders.length >= 100) return json({ error: "too many folders" }, 400);
      const id = folderId();
      folders.push({ id, name: name.slice(0, 60), createdAt: Date.now() });
      await saveFolders(env, user, folders);
      return json({ ok: true, folders, id });
    }
    if (body.action === "folders.rename") {
      const folders = await loadFolders(env, user);
      const f = folders.find((x) => x.id === body.id);
      if (!f) return json({ error: "folder not found" }, 404);
      f.name = (body.name || "").trim().slice(0, 60) || f.name;
      await saveFolders(env, user, folders);
      return json({ ok: true, folders });
    }
    if (body.action === "folders.delete") {
      let folders = await loadFolders(env, user);
      folders = folders.filter((x) => x.id !== body.id);
      await saveFolders(env, user, folders);
      const orphans = (await loadIndex(env, user)).filter((e) => e.folder === body.id).map((e) => e.id);
      if (orphans.length) await setMediaFolder(env, user, orphans, null);
      return json({ ok: true, folders });
    }
    if (body.action === "media.move") {
      await setMediaFolder(env, user, body.ids || [], body.folder || null);
      return json({ ok: true });
    }
    return json({ error: "unknown action: " + body.action }, 400);
  }

  const dataUrl = body && body.dataUrl;
  if (!dataUrl || !/^data:(image|video)\//.test(dataUrl)) return json({ error: "an image or video data URL is required" }, 400);
  if (dataUrl.length > 12000000) return json({ error: "file too large (max ~9MB)" }, 413);
  const type = /^data:video\//.test(dataUrl) ? "video" : "image";
  const entry = await addMedia(context.env, user, { type, provider: "upload", prompt: (body.name || "reference").slice(0, 120), dataUrl, projectId: body.projectId || null, folder: body.folder || null });
  return json({ ok: true, entry });
}

export async function onRequestDelete(context) {
  const user = await authUser(context);
  if (!user) return json({ error: "unauthorized" }, 401);
  let id = "";
  try { id = new URL(context.request.url).searchParams.get("id") || ""; } catch {}
  if (!id) return json({ error: "id required" }, 400);
  await removeMedia(context.env, user, id);
  return json({ ok: true, deleted: id });
}
