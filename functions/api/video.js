// functions/api/video.js
// POST /api/video                      -> Claude writes the Seedance prompt, then queue a render.
// GET  /api/video?job=<id>             -> poll; when complete, store the clip in the gallery.
// With no Venice key the prompt half still returns (Claude writes the YAML from the project).

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";
import { loadProject, composeSystem } from "./_projects.js";
import { CATALOG } from "./_catalog.js";
import { mergedCatalog } from "./_skills.js";
import { claudeComplete } from "./_llm.js";
import { getKeys, veniceVideoQueue, veniceVideoRetrieve, veniceSeedanceConsent, veniceVideoQuote, artcraftGenerate } from "./_providers.js";
import { addMedia } from "./_gallery.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) return json({ error: "unauthorized" }, 401);

  try {
  const clen = Number(request.headers.get("content-length") || 0);
  if (clen > 12000000) return json({ error: "Request too large (" + (clen / 1e6).toFixed(1) + " MB). A reference clip/image must be one generated in Parallax (sent by URL), not a large uploaded file." }, 413);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad body" }, 400); }
  const { projectId, brief, imageUrl } = body || {};
  const opts = body.options || {};
  const videos = Array.isArray(body.videos) ? body.videos.filter((v) => v && v.url) : []; // video-to-video references
  // Reference audio (music) — Seedance R2V only: ≤3 clips, 2–15s each, ≤15s combined (Venice's limits).
  const audios = Array.isArray(body.audio) ? body.audio.filter((a) => a && a.url).slice(0, 3) : [];
  if (!brief && !imageUrl && !videos.length) return json({ error: "brief, image, or video reference required" }, 400);

  const user = userFromToken(token);
  const project = projectId ? await loadProject(env, user, projectId) : null;
  const settings = (project && project.settings) || {};
  const provider = opts.provider || settings.provider || "venice";
  const keys = await getKeys(env, user);
  const promptModel = settings.promptModel || env.DEFAULT_PROMPT_MODEL || "claude-sonnet-4-20250514";

  // Step 1 — Claude writes the Seedance YAML (or use the brief raw with no project).
  let yaml = brief || "";
  const imgs = Array.isArray(body.images) ? body.images.filter((im) => im && im.data && im.media_type) : [];
  if (body.prewritten) {
    yaml = body.prewritten;
  } else if (project) {
    const content = [];
    imgs.forEach((im) => content.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }));
    if (imgs.length) content.push({ type: "text", text: `The ${imgs.length} image(s) above are references, labelled ${imgs.map((_, i) => "@image" + (i + 1)).join(", ")}. Reference them by those exact tokens in the prompt.` });
    if (imageUrl) content.push({ type: "text", text: `Reference image URL: ${imageUrl}` });
    content.push({ type: "text", text: brief || "Write a Seedance prompt for the provided reference image(s)." });
    try { yaml = await claudeComplete(keys.anthropic, promptModel, composeSystem(project, await mergedCatalog(env, user)), content); }
    catch (err) { return json({ error: "prompt generation failed: " + (err.message || "unknown") }); }
  }

  // Optional Chinese step (default off for Venice).
  let yamlZh = null;
  if (!body.prewritten && settings.translateChinese) {
    try {
      yamlZh = await claudeComplete(keys.anthropic, promptModel,
        "Translate this Seedance prompt to Simplified Chinese. Translate VALUES only; keep YAML keys, @imageN tokens, timestamps, and format specs in English. Output only the translated block.",
        [{ type: "text", text: yaml }]);
    } catch { /* non-fatal */ }
  }

  // Prompt-only mode: return the written Seedance prompt without rendering (for copy).
  if (body.promptOnly) return json({ ok: true, stage: "prompt", promptYaml: yaml, promptChinese: yamlZh });

  if (provider === "artcraft") {
    if (audios.length) return json({ error: "Audio references only render on Venice (Seedance reference→video) — switch this node's API to Venice.", promptYaml: yaml });
    if (!keys.artcraft || !keys.artcraftBase) return json({ ok: true, stage: "prompt", promptYaml: yaml, promptChinese: yamlZh, note: "ArtCraft not fully connected — add its key + base URL in Connections." });
    try {
      // Map the UI's friendly values -> ArtCraft's exact enums (from api.json).
      const AC_ASPECT = { "16:9": "landscape16x9", "9:16": "portrait9x16", "1:1": "square1x1", "4:3": "standard4x3", "3:4": "portrait3x4" };
      const AC_RES = { "1080p": "ten_eighty_p", "720p": "seven_twenty_p", "480p": "four_eighty_p" };
      let durSec = parseInt(String(opts.duration || settings.duration || "5"), 10) || 5;
      durSec = Math.min(15, Math.max(4, durSec));
      const acBody = {
        prompt: (settings.translateChinese && yamlZh ? yamlZh : yaml).slice(0, 10000),
        aspect_ratio: AC_ASPECT[opts.aspect_ratio || settings.aspect || "16:9"] || "landscape16x9",
        output_resolution: AC_RES[opts.resolution || settings.resolution || "1080p"] || "ten_eighty_p",
        duration_seconds: durSec,
        batch_count: "one",
        uuid_idempotency_token: crypto.randomUUID(),
      };
      const g = await artcraftGenerate(keys.artcraftBase, keys.artcraft, "video", opts.model || "multi_function/seedance_2p0", acBody);
      return json({ ok: true, stage: "queued", provider: "artcraft", job: g.job, promptYaml: yaml, promptChinese: yamlZh, note: imageUrl ? "Note: ArtCraft image-to-video reference upload is a follow-up; this used text-to-video." : null });
    } catch (err) { return json({ error: "ArtCraft video failed: " + (err.message || "unknown"), promptYaml: yaml }); }
  }

  if (provider === "venice" && !keys.venice) {
    return json({ ok: true, stage: "prompt", promptYaml: yaml, promptChinese: yamlZh, note: "Venice not connected — add your key in Connections to render." });
  }

  // Step 2 — queue the render (Venice).
  try {
    let model = opts.model || settings.model || "seedance-2-0-text-to-video";
    // Audio refs and multi-image refs only work on the reference-to-video variant — auto-route there.
    if ((videos.length || audios.length || imgs.length + (imageUrl ? 1 : 0) > 1) && !/reference/.test(String(model).toLowerCase())) {
      model = /fast/.test(String(model).toLowerCase()) ? "seedance-2-0-fast-reference-to-video" : "seedance-2-0-reference-to-video";
    }
    const m = String(model).toLowerCase();
    const isReference = /reference/.test(m);              // reference-to-video: reference_image_urls[] / reference_video_urls[]
    const isImageToVideo = /image-to-video|i2v|image_to_video/.test(m); // first-frame image_url, no aspect_ratio

    // Attached images (base64) become Venice reference inputs. A URL in `imageUrl` works too.
    const dataUrls = [];
    imgs.forEach((im) => dataUrls.push(`data:${im.media_type};base64,${im.data}`));
    if (imageUrl) dataUrls.push(imageUrl);

    const params = {
      model,
      prompt: ((settings.translateChinese && yamlZh ? yamlZh : yaml) || (videos.length ? "Recreate and enhance the reference video." : "")).slice(0, 10000),
      duration: opts.duration || settings.duration || "5s",
      resolution: opts.resolution || settings.resolution || "1080p",
    };

    // Video references (video-to-video): URLs or data-URLs + the summed duration Venice needs for pricing.
    let refVideoTotal = 0;
    if (videos.length) {
      params.reference_video_urls = videos.map((v) => v.url).slice(0, 3);
      refVideoTotal = videos.slice(0, 3).reduce((s, v) => s + (Number(v.duration) || 0), 0);
      if (refVideoTotal > 0) params.reference_video_total_duration = Math.round(refVideoTotal);
    }
    // Reference audio: Venice rejects audio-only submissions — it needs an image or clip to ground it.
    let audTotal = 0;
    if (audios.length) {
      if (!dataUrls.length && !videos.length) return json({ error: "Venice needs at least one image or video reference alongside audio — connect an image to this node or drop one in its ref spot." });
      params.reference_audio_urls = audios.map((a) => a.url);
      audTotal = audios.reduce((t, a) => t + (Number(a.duration) || 0), 0);
      if (audTotal > 15) return json({ error: "Audio references total " + Math.round(audTotal) + "s — Venice caps combined reference audio at 15s. Trim the clip(s)." });
    }

    // NOTE: `negative_prompt` / `generate_audio` are NOT in Venice's documented video API and
    // were causing the queue call to fail — removed until confirmed. (Audio is on by default on
    // Seedance anyway.) If you want a negative, fold it into the prompt for now.

    // Route the image(s) to the correct field for the chosen workflow.
    let usingFirstFrameImage = false;
    if (dataUrls.length) {
      if (isReference) {
        params.reference_image_urls = dataUrls.slice(0, 9); // R2V accepts 1–9
      } else {
        params.image_url = dataUrls[0];                     // I2V / default first-frame
        usingFirstFrameImage = true;
      }
    }
    // aspect_ratio: image-to-video derives it from the image and REJECTS the field.
    if (!usingFirstFrameImage && !isImageToVideo && (opts.aspect_ratio || settings.aspect)) {
      params.aspect_ratio = opts.aspect_ratio || settings.aspect;
    }

    // Face-media consent: only attach the attestation when the client has confirmed it.
    if (body.consent === true) params.consents = { seedance: veniceSeedanceConsent() };

    // Guard: large inline base64 refs blow the Worker's CPU/memory budget (JSON.stringify) →
    // Cloudflare kills the isolate and returns an HTML 502. Reject cleanly instead of crashing.
    const inlineBytes = (arr) => (arr || []).reduce((s, u) => s + (typeof u === "string" && /^data:/.test(u) ? Math.floor(u.length * 0.75) : 0), 0);
    const refBytes = inlineBytes(params.reference_video_urls) + inlineBytes(params.reference_image_urls) + inlineBytes(params.reference_audio_urls) + inlineBytes(params.image_url ? [params.image_url] : []);
    if (refBytes > 4000000) return json({ error: "Reference media is too large to send inline (~" + (refBytes / 1e6).toFixed(1) + " MB). Use a clip/image generated in Parallax (referenced by URL), or a smaller file.", promptYaml: yaml }, 413);

    console.log("[video] queue start", model, "refImgs", (params.reference_image_urls || []).length, "refVids", (params.reference_video_urls || []).length, "refAud", (params.reference_audio_urls || []).length, "promptLen", (params.prompt || "").length);
    const q = await veniceVideoQueue(keys.venice, params);
    console.log("[video] queued ok", q && q.job);

    // Venice asked for face-consent — bubble the policy up so the user can attest.
    if (q.needsConsent) {
      return json({ ok: true, stage: "consent", provider: "venice", policyText: q.policyText, faceRoles: q.faceRoles, model: q.model, promptYaml: yaml, promptChinese: yamlZh });
    }

    // Quote call REMOVED from the hot path: once the job is queued, awaiting the price could push
    // total function time past Cloudflare's limit → the isolate is killed and you get a 502 even
    // though Venice queued fine. Price comes from the client-side balance delta instead.
    let quoteUsd = null;

    return json({ ok: true, stage: "queued", provider, job: q.job, model: q.model, downloadUrl: q.downloadUrl, promptYaml: yaml, promptChinese: yamlZh, balanceUsd: q.balanceUsd, quoteUsd });
  } catch (err) {
    return json({ error: "queue failed: " + (err.message || "unknown"), promptYaml: yaml });
  }
  } catch (fatal) { return json({ error: "video failed: " + (fatal.message || "unknown") }); }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) return json({ error: "unauthorized" }, 401);

  let job = "", model = "", projectId = "";
  try { const u = new URL(request.url); job = u.searchParams.get("job") || ""; model = u.searchParams.get("model") || ""; projectId = u.searchParams.get("projectId") || ""; } catch {}
  if (!job) return json({ error: "job required" }, 400);

  const user = userFromToken(token);
  const keys = await getKeys(env, user);
  if (!keys.venice) return json({ error: "Venice not connected" });

  try {
    const r = await veniceVideoRetrieve(keys.venice, job, model);
    let mediaId = null;
    if (r.done && r.url) {
      const isData = r.url.startsWith("data:");
      const entry = await addMedia(env, user, { type: "video", provider: "venice", dataUrl: isData ? r.url : null, url: isData ? null : r.url, projectId: projectId || null, meta: { queueId: job } });
      mediaId = entry ? entry.id : null;
    }
    return json({ ok: true, status: r.status, url: r.done ? r.url : null, mediaId });
  } catch (err) {
    return json({ error: "retrieve failed: " + (err.message || "unknown") });
  }
}
