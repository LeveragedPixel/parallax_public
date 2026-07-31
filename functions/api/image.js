// functions/api/image.js — POST /api/image
// Step 1: Claude writes the image prompt in the project's voice (skip if no project).
// Step 2: generate via the chosen provider. Venice returns images synchronously;
// ArtCraft returns a job token to poll via /api/genjob.

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";
import { loadProject, composeSystem } from "./_projects.js";
import { CATALOG } from "./_catalog.js";
import { mergedCatalog } from "./_skills.js";
import { claudeComplete } from "./_llm.js";
import { getKeys, openaiImage } from "./_providers.js";   // v60: image = OpenAI only
import { addMedia } from "./_gallery.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
function firstBlock(text) {
  const m = text.match(/```[a-z]*\n([\s\S]*?)```/i);
  return (m ? m[1] : text).trim();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) return json({ error: "unauthorized" }, 401);

  try {
  const clen = Number(request.headers.get("content-length") || 0);
  if (clen > 12000000) return json({ error: "Request too large (" + (clen / 1e6).toFixed(1) + " MB). Reference images must be smaller — a large inline image can crash the function." }, 413);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad body" }, 400); }
  const { projectId, brief } = body || {};
  const opts = body.options || {};
  if (!brief) return json({ error: "brief required" }, 400);

  const user = userFromToken(token);
  const project = projectId ? await loadProject(env, user, projectId) : null;
  const settings = (project && project.settings) || {};
  // v60: IMAGE GENERATION IS OPENAI-ONLY. Venice/ArtCraft credits are reserved for
  // video (Seedance); routing an image at them silently burned those credits. The
  // server refuses instead of trusting whatever provider the client asked for.
  const askedProvider = opts.provider || settings.provider || "openai";
  const provider = "openai";
  const keys = await getKeys(env, user);

  // Step 1 — prompt.
  let promptUsed = brief;
  const imgs = Array.isArray(body.images) ? body.images.filter((im) => im && im.data && im.media_type) : [];
  if (body.prewritten) {
    promptUsed = firstBlock(body.prewritten);
  } else if (project) {
    const promptModel = settings.promptModel || env.DEFAULT_PROMPT_MODEL || "claude-sonnet-4-20250514";
    const content = [];
    imgs.forEach((im) => content.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }));
    if (imgs.length) content.push({ type: "text", text: `The image(s) above are references (@image1${imgs.length > 1 ? "…" : ""}).` });
    content.push({ type: "text", text: brief });
    try {
      const written = await claudeComplete(keys.anthropic, promptModel, composeSystem(project, await mergedCatalog(env, user)), content);
      promptUsed = firstBlock(written);
    } catch (err) { return json({ error: "prompt generation failed: " + (err.message || "unknown") }); }
  }

  // Prompt-only mode: return the written prompt without generating (for copy / preview).
  if (body.promptOnly) return json({ ok: true, stage: "prompt", promptUsed });

  // Step 2 — generate (OpenAI only).
  if (askedProvider !== "openai") {
    return json({ error: `Image generation runs on OpenAI only — "${askedProvider}" is reserved for video, so nothing was charged there. This node now targets GPT Image; hit Generate again.`, promptUsed });
  }
  {
    if (!keys.openai) return json({ ok: true, stage: "prompt", promptUsed, note: "OpenAI not connected — add your key in Connections to render with GPT Image." });
    try {
      const out = await openaiImage(keys.openai, { model: opts.model || "gpt-image-2", prompt: promptUsed.slice(0, 30000), aspect: opts.aspect_ratio || "1:1", quality: opts.quality || "medium", n: opts.variants });
      if (!out.images.length) return json({ error: "OpenAI returned no image", promptUsed });
      const saved = [];
      for (const b64 of out.images) {
        const dataUrl = `data:image/png;base64,${b64}`;
        const entry = await addMedia(env, user, { type: "image", provider: "openai", prompt: promptUsed, dataUrl, projectId: project ? project.id : null, meta: { model: opts.model || "gpt-image-2", quality: opts.quality || "medium" } });
        saved.push({ id: entry ? entry.id : null, dataUrl });
      }
      return json({ ok: true, stage: "generated", provider: "openai", promptUsed, images: saved });
    } catch (err) { return json({ error: "OpenAI image failed: " + (err.message || "unknown"), promptUsed }); }
  }
  } catch (fatal) { return json({ error: "image failed: " + (fatal.message || "unknown") }); }
}
