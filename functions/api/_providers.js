// functions/api/_providers.js — media provider adapters (Venice + ArtCraft).
// Keys/config live in KV ("keys:<user>" -> {venice, artcraft, artcraft_base}) with env
// fallback, and are never returned to the browser.

const VENICE = "https://api.venice.ai/api/v1";

export async function getKeys(env, user) {
  let stored = {};
  if (env.PARALLAX_KV) {
    const raw = await env.PARALLAX_KV.get("keys:" + user);
    if (raw) { try { stored = JSON.parse(raw) || {}; } catch {} }
  }
  return {
    anthropic: stored.anthropic || env.ANTHROPIC_API_KEY || "",
    openai: stored.openai || env.OPENAI_API_KEY || "",
    venice: stored.venice || env.VENICE_API_KEY || "",
    artcraft: stored.artcraft || env.ARTCRAFT_API_KEY || "",
    artcraftBase: (stored.artcraft_base || env.ARTCRAFT_BASE_URL || "").replace(/\/+$/, ""),
  };
}
export async function saveKey(env, user, field, value) {
  if (!env.PARALLAX_KV) throw new Error("KV not configured");
  const raw = await env.PARALLAX_KV.get("keys:" + user);
  let cur = {};
  if (raw) { try { cur = JSON.parse(raw) || {}; } catch {} }
  cur[field] = value;
  await env.PARALLAX_KV.put("keys:" + user, JSON.stringify(cur));
}

/* ---------------- Venice ---------------- */
// Seedance 2.0 video variants (official IDs from docs.venice.ai/guides/media/seedance-2-0).
// Venice's /models?type=video does not always enumerate these, so we always merge them in —
// labelled by workflow so the operator knows which one uses an attached image.
const VENICE_SEEDANCE_VIDEO = [
  { id: "seedance-2-0-reference-to-video", label: "Seedance 2.0 · reference→video (uses image)", type: "video" },
  { id: "seedance-2-0-image-to-video", label: "Seedance 2.0 · image→video (first frame)", type: "video" },
  { id: "seedance-2-0-text-to-video", label: "Seedance 2.0 · text→video", type: "video" },
  { id: "seedance-2-0-fast-reference-to-video", label: "Seedance 2.0 Fast · reference→video (uses image)", type: "video" },
  { id: "seedance-2-0-fast-image-to-video", label: "Seedance 2.0 Fast · image→video (first frame)", type: "video" },
  { id: "seedance-2-0-fast-text-to-video", label: "Seedance 2.0 Fast · text→video", type: "video" },
];
export async function veniceModels(key, type) {
  const res = await fetch(`${VENICE}/models?type=${encodeURIComponent(type)}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Venice models ${res.status}`);
  const d = await res.json();
  let models = (d.data || []).map((m) => ({ id: m.id, label: (m.model_spec && m.model_spec.name) || m.id, type: m.type }));
  if (type === "video") {
    const have = new Set(models.map((m) => m.id));
    const inject = VENICE_SEEDANCE_VIDEO.filter((s) => !have.has(s.id));
    models = [...inject, ...models]; // Seedance first so it's easy to find
  }
  return models;
}
export async function veniceBalance(key) {
  const res = await fetch(`${VENICE}/models?type=image`, { headers: { Authorization: `Bearer ${key}` } });
  const usd = res.headers.get("x-venice-balance-usd");
  return { usd: usd != null ? Number(usd) : null };
}
// A slow model (or a multi-variant render) can outlive the platform's patience — without
// our own timeout the isolate gets killed and the client sees an HTML 502 instead of a
// reason (same failure class the video queue hit; see veniceVideoQueue below).
export async function veniceImage(key, params) {
  let res;
  try {
    res = await fetch(`${VENICE}/image/generate`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(params),
      signal: AbortSignal.timeout(95000),
    });
  } catch (e) {
    throw new Error(`Venice image ${e.name === "TimeoutError" ? "timed out (95s) — this model can't finish this render even at Venice's own limit; use a faster model for drafts (SD 3.5 etc.), or try ×1 at 1:1" : "unreachable"} — ${e.message || e.name}`);
  }
  const usd = res.headers.get("x-venice-balance-usd");
  if (!res.ok) {
    const t = await res.text();
    // Venice's own edge returns an HTML error page when a render outlives THEIR limit —
    // translate it instead of dumping markup into the node status.
    if (/^\s*</.test(t)) throw new Error(`Venice's servers gave up (${res.status}) before the render finished — this model/size can't be delivered by Venice's synchronous API. Use a faster model, ×1, or a smaller aspect.`);
    throw new Error(`Venice image ${res.status}: ${t.slice(0, 180)}`);
  }
  const d = await res.json();
  return { images: d.images || [], id: d.id || null, balanceUsd: usd != null ? Number(usd) : null };
}
// Queue a Seedance/Venice video render.
// Handles the face-media CONSENT flow: when a face is detected and no consent was sent,
// Venice returns a non-charging 409 { error.code: "needs_consent", consent.policy_text, ... }.
// We surface that as { needsConsent, policyText, faceRoles } instead of throwing, so the UI
// can show the attestation text and resubmit with consents.seedance. A short timeout turns a
// hung upstream into a clean error rather than a Cloudflare 502.
export async function veniceVideoQueue(key, params) {
  let res;
  try {
    res = await fetch(`${VENICE}/video/queue`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(params), signal: AbortSignal.timeout(18000),
    });
  } catch (e) {
    throw new Error(`Venice video/queue ${e.name === "TimeoutError" ? "timed out (18s) — Venice's queue was slow to respond; try again" : "unreachable"} — ${e.message || e.name}`);
  }
  const usd = res.headers.get("x-venice-balance-usd");
  const text = await res.text();
  let d = {}; try { d = JSON.parse(text); } catch {}

  // 409 needs_consent — face detected, attestation required (does not charge).
  if (res.status === 409 && (d.error?.code === "needs_consent" || d.consent_flow === "seedance")) {
    return {
      needsConsent: true,
      policyText: d.consent?.policy_text || "The likeness in any media you upload is your own, or you have explicit legal consent from every depicted person. You own or have permission to use all uploaded media. You agree to the Venice Terms of Service and Privacy Policy.",
      faceRoles: d.face_media_roles || [],
      model: params.model,
      balanceUsd: usd != null ? Number(usd) : null,
    };
  }
  if (!res.ok) throw new Error(`Venice video ${res.status}: ${(d.error?.message || text || "").slice(0, 200)}`);
  return { job: d.queue_id || d.id || null, model: params.model, downloadUrl: d.download_url || null, raw: d, balanceUsd: usd != null ? Number(usd) : null };
}

// The Seedance consent object — all three confirmations must be boolean true, and NO extra
// fields (an extra key like consent_version is rejected with a 400).
export function veniceSeedanceConsent() {
  return { confirmed_terms_and_privacy: true, confirmed_legal_right: true, confirmed_screening_acknowledged: true };
}

// Real per-request price from Venice's authoritative quote endpoint. Best-effort; returns
// null on any failure so the caller can fall back to the balance-delta estimate.
export async function veniceVideoQuote(key, params) {
  try {
    const res = await fetch(`${VENICE}/video/quote`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(params), signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const usd = d.usd ?? d.cost_usd ?? d.price_usd ?? (d.cost_in_usd_cents != null ? d.cost_in_usd_cents / 100 : null);
    return { usd: usd != null ? Number(usd) : null, raw: d };
  } catch { return null; }
}
function b64chunk(buf) {
  const bytes = new Uint8Array(buf); let bin = ""; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
// Venice /video/retrieve wants { queue_id, model }. While PROCESSING it returns JSON
// with `status`; when COMPLETED it returns the raw mp4 binary — so we sniff content-type.
export async function veniceVideoRetrieve(key, queueId, model) {
  const res = await fetch(`${VENICE}/video/retrieve`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ queue_id: queueId, model }),
  });
  if (!res.ok) throw new Error(`Venice retrieve ${res.status}: ${(await res.text()).slice(0, 180)}`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const d = await res.json();
    return { done: d.status === "COMPLETED", status: d.status || "PROCESSING", url: null };
  }
  const buf = await res.arrayBuffer();
  return { done: true, status: "COMPLETED", url: `data:video/mp4;base64,${b64chunk(buf)}` };
}

/* ---------------- ArtCraft (Storyteller API) ----------------
   Model = endpoint path suffix. Generation is async: POST -> inference_job_token,
   then poll /v1/jobs/job/{token}. Base URL + auth header come from the connection
   (the OpenAPI spec omits both). Auth is assumed Bearer — flip AC_AUTH if it differs. */
function acHeaders(key) {
  // Browser-like UA + Accept: some Cloudflare-fronted APIs hang/deny the default
  // "Cloudflare-Workers" user-agent. This can slip a server-side call past bot filtering.
  return {
    Authorization: `Bearer ${key}`,
    "content-type": "application/json",
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  };
}
// Read an ArtCraft response, turning an HTML page (challenge / auth redirect / wrong URL)
// into a clear message instead of a raw "Unexpected token '<'" JSON-parse crash.
async function acRead(res, label) {
  const text = await res.text();
  const head = text.trimStart().slice(0, 120);
  if (text.trimStart().startsWith("<")) throw new Error(`${label} returned HTML, not JSON (HTTP ${res.status}) — usually a wrong auth header or a Cloudflare challenge. First bytes: ${head}`);
  if (!res.ok) throw new Error(`${label} ${res.status}: ${head}`);
  try { return JSON.parse(text); } catch { throw new Error(`${label} sent invalid JSON (HTTP ${res.status})`); }
}

export const ARTCRAFT_MODELS = {
  image: [
    { id: "multi_function/nano_banana_pro", label: "Nano Banana Pro" },
    { id: "multi_function/nano_banana_2", label: "Nano Banana 2" },
    { id: "multi_function/bytedance_seedream_v4p5", label: "Seedream v4.5" },
    { id: "multi_function/bytedance_seedream_v4", label: "Seedream v4" },
    { id: "multi_function/gpt_image_1p5", label: "GPT Image 1.5" },
    { id: "flux_pro_1.1_ultra_text_to_image", label: "FLUX Pro 1.1 Ultra" },
    { id: "flux_pro_1.1_text_to_image", label: "FLUX Pro 1.1" },
    { id: "gpt_image_1_text_to_image", label: "GPT Image 1" },
    { id: "flux_1_dev_text_to_image", label: "FLUX.1 dev" },
  ],
  video: [
    { id: "multi_function/seedance_2p0", label: "Seedance 2.0" },
    { id: "multi_function/seedance_1p5_pro", label: "Seedance 1.5 Pro" },
    { id: "multi_function/kling_3p0_pro", label: "Kling 3.0 Pro" },
    { id: "multi_function/kling_3p0_standard", label: "Kling 3.0 Standard" },
    { id: "multi_function/kling_2p6_pro", label: "Kling 2.6 Pro" },
    { id: "multi_function/sora_2", label: "Sora 2" },
    { id: "multi_function/sora_2_pro", label: "Sora 2 Pro" },
    { id: "multi_function/veo_3p1", label: "Veo 3.1" },
    { id: "multi_function/veo_3p1_fast", label: "Veo 3.1 Fast" },
  ],
};
export function artcraftModels(type) {
  return ARTCRAFT_MODELS[type] || [];
}

// Kick off a generation. `kind` = "image"|"video"; `modelId` = a path suffix above.
export async function artcraftGenerate(base, key, kind, modelId, body) {
  if (!base) throw new Error("ArtCraft base URL not set — add it in Connections");
  const url = `${base}/v1/generate/${kind}/${modelId}`;
  let res;
  try { res = await fetch(url, { method: "POST", headers: acHeaders(key), body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }); }
  catch (e) { throw new Error(`ArtCraft unreachable at ${url} (${e.name || e.message}) — host is not responding to server-side calls (timed out).`); }
  const d = await acRead(res, "ArtCraft");
  return { job: d.inference_job_token || (d.all_inference_job_tokens && d.all_inference_job_tokens[0]) || null, raw: d };
}

// Credits remaining. ArtCraft's exact balance endpoint isn't in the spec we have, so this
// tries the likely account endpoints, short-timeout each. While the server-side wall is up
// every attempt times out -> we return {error:true} and the UI shows "artcraft: parked".
export async function artcraftBalance(base, key) {
  if (!base) return { error: true };
  // One tight-timeout probe only — a parked host would otherwise stack timeouts and risk a
  // 502 on /api/connections itself. If the endpoint guess is wrong once ArtCraft is reachable,
  // we adjust the path then; the graceful fallback is {error:true} -> "artcraft: parked".
  try {
    const res = await fetch(`${base}/v1/account/credits`, { headers: acHeaders(key), signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { error: true };
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("json")) return { error: true };
    const d = await res.json();
    const credits = d.credits ?? d.credit_balance ?? d.balance ?? (d.account && d.account.credits) ?? null;
    return credits != null ? { credits: Number(credits) } : { error: true };
  } catch { return { error: true }; }
}

// Cost estimate (exact credits per gen).
export async function artcraftCost(base, key, kind, params) {
  if (!base) return null;
  try {
    const res = await fetch(`${base}/v1/generate/cost_estimate/${kind}`, { method: "POST", headers: acHeaders(key), body: JSON.stringify(params) });
    if (!res.ok) return null;
    const d = await res.json();
    return { credits: d.cost_in_credits, usdCents: d.cost_in_usd_cents, free: d.is_free, unlimited: d.is_unlimited };
  } catch { return null; }
}

// Poll a job. Returns {status, done, failed, url, raw}.
export async function artcraftJob(base, key, token) {
  let res;
  try { res = await fetch(`${base}/v1/jobs/job/${token}`, { headers: acHeaders(key), signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw new Error(`ArtCraft job unreachable (${e.name || e.message})`); }
  const d = await acRead(res, "ArtCraft job");
  const st = (d.state && d.state.status && d.state.status.status) || "pending";
  const done = st === "complete_success";
  const failed = /failure|dead|cancelled/.test(st);
  let url = null;
  if (done && d.state && d.state.maybe_result != null) url = findUrl(d.state.maybe_result);
  return { status: st, done, failed, url, raw: d };
}

// Best-effort: find a media URL anywhere in the (union-shaped) result object.
function findUrl(o, depth = 0) {
  if (o == null || depth > 6) return null;
  if (typeof o === "string") return /^https?:\/\//.test(o) ? o : null;
  if (Array.isArray(o)) { for (const v of o) { const u = findUrl(v, depth + 1); if (u) return u; } return null; }
  if (typeof o === "object") {
    for (const k of Object.keys(o)) {
      if (/url|uri|src/i.test(k) && typeof o[k] === "string" && /^https?:\/\//.test(o[k])) return o[k];
    }
    for (const k of Object.keys(o)) { const u = findUrl(o[k], depth + 1); if (u) return u; }
  }
  return null;
}
