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
import { getKeys, openaiImage, veniceImage, artcraftGenerate } from "./_providers.js";
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
  // v66: every provider the APIs offer is available again. v60 had hard-locked images to
  // OpenAI because Venice image renders were silently eating Seedance credits — the fix
  // now lives in the UI instead: Generate opens a confirmation naming the exact API and
  // model before anything is charged. The default is still OpenAI, so nothing changes
  // unless it was deliberately picked.
  const provider = opts.provider || settings.provider || "openai";
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

  // Step 2 — generate.
  if (provider === "openai") {
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
      return json({ ok: true, stage: "generated", provider: "openai", model: opts.model || "gpt-image-2", promptUsed, images: saved });
    } catch (err) { return json({ error: "OpenAI image failed: " + (err.message || "unknown"), promptUsed }); }
  }
  if (provider === "artcraft") {
    if (!keys.artcraft || !keys.artcraftBase) return json({ ok: true, stage: "prompt", promptUsed, note: "ArtCraft not fully connected — add its key + base URL in Connections." });
    try {
      // Map the UI's friendly values -> ArtCraft's exact enums (from api.json).
      const AC_ASPECT = { "1:1": "one_by_one", "16:9": "sixteen_by_nine", "9:16": "nine_by_sixteen", "4:3": "four_by_three", "3:2": "three_by_two" };
      const AC_COUNT = { "1": "one", "2": "two", "3": "three", "4": "four" };
      const acBody = {
        prompt: promptUsed.slice(0, 7500),
        aspect_ratio: AC_ASPECT[opts.aspect_ratio || "1:1"] || "auto",
        num_images: AC_COUNT[String(opts.variants || "1")] || "one",
        resolution: opts.resolution || "two_k",
        uuid_idempotency_token: crypto.randomUUID(),
      };
      const g = await artcraftGenerate(keys.artcraftBase, keys.artcraft, "image", opts.model || "multi_function/nano_banana_pro", acBody);
      return json({ ok: true, stage: "queued", provider: "artcraft", model: opts.model || "multi_function/nano_banana_pro", job: g.job, promptUsed });
    } catch (err) { return json({ error: "ArtCraft image failed: " + (err.message || "unknown"), promptUsed }); }
  }

  if (!keys.venice) return json({ ok: true, stage: "prompt", promptUsed, note: "Venice not connected — add your key in Connections to generate." });
  try {
    const fmt = opts.format || "webp";
    const params = { model: opts.model || settings.model || "venice-sd35", prompt: promptUsed.slice(0, 7500), format: fmt, safe_mode: false };
    if (opts.negative_prompt) params.negative_prompt = opts.negative_prompt;
    if (opts.aspect_ratio) params.aspect_ratio = opts.aspect_ratio;
    if (opts.resolution) params.resolution = opts.resolution;
    if (opts.variants) params.variants = Number(opts.variants);
    const out = await veniceImage(keys.venice, params);
    const saved = [];
    for (const b64 of out.images) {
      const dataUrl = `data:image/${fmt};base64,${b64}`;
      const entry = await addMedia(env, user, { type: "image", provider: "venice", prompt: promptUsed, dataUrl, projectId: project ? project.id : null, meta: { model: params.model } });
      saved.push({ id: entry ? entry.id : null, dataUrl });
    }
    return json({ ok: true, stage: "generated", provider: "venice", model: params.model, promptUsed, images: saved, balanceUsd: out.balanceUsd });
  } catch (err) { return json({ error: "image gen failed: " + (err.message || "unknown"), promptUsed }); }
  } catch (fatal) { return json({ error: "image failed: " + (fatal.message || "unknown") }); }
}
