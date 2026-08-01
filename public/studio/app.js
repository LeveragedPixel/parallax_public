/* PARALLAX 2.0 — deck client
   Chat = project columns (both minds answer inside each column) · Image/Video generation ·
   provider connections · usage meters · reference-wall dock · author skills. */

const BUILD = 63; // v63: music video pipeline — dedicated 🎵 audio section with in-browser song slicing, + Music Video project template
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "plx-token";
const THEMES = ["midnight","ember","cobalt","crimson","unit01","bebop","ronin","hivis","toxin","ice","ghost","akira","sakura","oni","mecha","vapor","tatami","magma","ocean","violet","terminal"];
const MODEL_KEYS = { claude: "plx-model-claude", gpt: "plx-model-gpt" };

let token = localStorage.getItem(TOKEN_KEY) || "";
let projects = [], editingId = null;
let colConvos = {};
const loadedConvos = new Set(), saveTimers = {}; // conversation persistence (per-project threads)
// Hydrate a project's saved thread from KV (once). Won't clobber in-memory turns.
async function loadConvo(id) {
  if (!id || loadedConvos.has(id)) return;
  loadedConvos.add(id);
  try { const d = await api("/api/conversations?projectId=" + encodeURIComponent(id)); if (Array.isArray(d.messages) && d.messages.length && !(colConvos[id] && colConvos[id].length)) colConvos[id] = d.messages; } catch {}
}
// Trim before saving: keep all text, but only the last 3 image turns' blobs (payload stays small).
function trimForSave(conv) {
  const arr = (conv || []).slice(-200); let imgSeen = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const t = arr[i];
    if (t && ((t.images && t.images.length) || (t.thumbs && t.thumbs.length))) { imgSeen++; if (imgSeen > 3) arr[i] = { who: t.who, text: t.text || "[image]" }; }
  }
  return arr;
}
function saveConvo(id) {
  if (!id) return;
  clearTimeout(saveTimers[id]);
  saveTimers[id] = setTimeout(() => { api("/api/conversations", { projectId: id, messages: trimForSave(colConvos[id]) }).catch(() => {}); }, 400);
}
let laneOn = JSON.parse(localStorage.getItem("plx-lanes") || '{"claude":true,"gpt":true}');
let genModelsCache = {}, veniceUsd = null, sessionSpend = 0;
let artcraftCredits = null, artcraftState = "off"; // off | connected | blocked
let lastGenCost = null;
let galTab = "image", galMedia = [], galSel = {}, galFolded = {}; // gallery: tab, cached index, selection map, collapsed folders
let galFolders = [], galSort = "new"; // user-created folders + sort order ("new" | "old")

const authHeaders = () => ({ Authorization: "Bearer " + token, "Content-Type": "application/json" });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const userFromToken = (t) => { try { return atob(t.split(".")[0]).split(".")[0] || "user"; } catch { return "user"; } };
function toast(m) { const t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2400); }
async function api(path, body, method) {
  const r = await fetch(path, { method: method || (body ? "POST" : "GET"), headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { logout(); throw new Error("session expired"); }
  // Read as text first so a Cloudflare/HTML error page never becomes a raw
  // "Unexpected token '<' … not valid JSON". Turn it into a plain-language reason.
  const raw = await r.text();
  const head = raw.trimStart().slice(0, 60);
  if (raw.trimStart().startsWith("<")) {
    if (r.status === 502 || r.status === 504) throw new Error(`the provider took too long and the request timed out (HTTP ${r.status}). If the provider is ArtCraft, it's still the parked server-side wall — switch to Venice.`);
    throw new Error(`server returned an error page (HTTP ${r.status}) instead of data. First bytes: ${head}`);
  }
  try { return JSON.parse(raw); }
  catch { throw new Error(`server sent an unreadable response (HTTP ${r.status}): ${head || "empty"}`); }
}
const show = (el) => $(el).classList.remove("hide");
const hide = (el) => $(el).classList.add("hide");
function copyText(t) { navigator.clipboard.writeText(t).then(() => toast("copied")).catch(() => toast("copy failed")); }
function fileToImg(f) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => { const url = r.result; const m = /^data:([^;]+);base64,(.*)$/.exec(url); m ? res({ media_type: m[1], data: m[2], dataUrl: url }) : rej(new Error("unsupported")); };
    r.onerror = rej; r.readAsDataURL(f);
  });
}
async function collectImages(files, arr, render) {
  for (const f of [...files]) {
    if (!f || !f.type || !f.type.startsWith("image/")) continue;
    if (f.size > 6000000) { toast((f.name || "image") + ": too large (max ~6MB)"); continue; }
    try { arr.push(await fileToImg(f)); } catch { toast("couldn't read image"); }
  }
  render();
}
/* --- voice input: record the mic -> transcribe -> insert into a textarea (reuses /api/transcribe) --- */
let activeRec = null;
function setMicState(btn, state) {
  if (!btn) return; btn.dataset.state = state;
  if (state === "recording") { btn.textContent = "■"; btn.title = "stop & transcribe"; btn.classList.add("rec"); }
  else if (state === "busy") { btn.textContent = "…"; btn.title = "transcribing"; btn.classList.remove("rec"); }
  else { btn.textContent = "🎤"; btn.title = "record voice"; btn.classList.remove("rec"); }
}
function insertDictation(ta, text) { if (!ta || !text) return; const cur = (ta.value || "").trim(); ta.value = cur ? cur + " " + text : text; ta.dispatchEvent(new Event("input")); ta.focus(); }
async function toggleMic(ta, btn) {
  if (activeRec) { if (activeRec.rec.state !== "inactive") activeRec.rec.stop(); return; }   // second click = stop
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast("voice recording isn't supported in this browser"); return; }
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { toast("microphone blocked — allow mic access"); return; }
  const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : (MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "");
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const type = rec.mimeType || mime || "audio/webm", ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm";
    const blob = new Blob(chunks, { type }); activeRec = null; setMicState(btn, "busy");
    if (!blob.size) { toast("nothing recorded"); setMicState(btn, "idle"); return; }
    try {
      const fd = new FormData(); fd.append("file", blob, "voice." + ext);
      const r = await fetch("/api/transcribe", { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
      const d = await r.json();
      if (!d.ok) toast(d.error || "transcription failed"); else if (d.text) { insertDictation(ta, d.text); toast("added your voice"); } else toast("didn't catch that");
    } catch (e) { toast("transcribe failed: " + (e.message || e)); }
    setMicState(btn, "idle");
  };
  activeRec = { rec, stream, btn, ta }; setMicState(btn, "recording"); rec.start();
}
function clearEmpty(el) { const e = el.querySelector(".empty"); if (e) e.remove(); }

/* theme + meters */
function initTheme() {
  const sel = $("themeSel"); sel.innerHTML = "";
  for (const t of THEMES) { const o = document.createElement("option"); o.value = t; o.textContent = t.toUpperCase(); sel.appendChild(o); }
  const saved = localStorage.getItem("plx-theme") || "midnight"; sel.value = saved; document.body.dataset.theme = saved;
  sel.onchange = () => { document.body.dataset.theme = sel.value; localStorage.setItem("plx-theme", sel.value); };
}
// Estimated $ per 1M tokens by model family. Anthropic/OpenAI don't expose a remaining
// balance to API keys, so Claude+GPT show est. SPEND (this session); Venice shows real
// balance REMAINING. Tell me exact rates and I'll set them — these are best-guess defaults.
function priceFor(model) {
  const m = (model || "").toLowerCase();
  if (/opus/.test(m)) return { in: 15, out: 75 };
  if (/sonnet/.test(m)) return { in: 3, out: 15 };
  if (/haiku/.test(m)) return { in: 0.8, out: 4 };
  if (/gpt|chatgpt|^o[0-9]/.test(m)) return { in: 2.5, out: 10 };
  return { in: 3, out: 15 };
}
/* Account balances (v45): Venice reports a real balance over its API; Anthropic and
   OpenAI expose none to API keys — so for those, the user sets their credit balance
   in Connections and the studio counts down from it using real token usage, synced
   to the account (/api/balances) so it follows any computer. */
let acctBal = { anthropic: null, openai: null };
let _balTimer = {};
async function loadBalances() {
  try {
    const d = await api("/api/balances");
    const b = d.balances || {};
    acctBal.anthropic = b.anthropic && b.anthropic.usd != null ? Number(b.anthropic.usd) : null;
    acctBal.openai = b.openai && b.openai.usd != null ? Number(b.openai.usd) : null;
  } catch {}
  updateMeters();
}
function pushBalance(provider) {
  clearTimeout(_balTimer[provider]);
  _balTimer[provider] = setTimeout(() => { api("/api/balances", { provider, usd: acctBal[provider] }).catch(() => {}); }, 1500);
}
// Month-to-date org spend pulled from the providers' cost APIs (needs admin keys).
let orgSpend = { anthropic: null, openai: null, anthropicErr: null, openaiErr: null };
// REMAINING credit where a provider actually exposes it (OpenAI grants, Venice balances).
let credits = { openai: null, openaiErr: null, anthropicNote: "", venice: { usd: null, vcu: null, diem: null } };
async function loadSpend() {
  try {
    const d = await api("/api/spend");
    orgSpend.anthropic = d.anthropic && d.anthropic.monthUsd != null ? Number(d.anthropic.monthUsd) : null;
    orgSpend.openai = d.openai && d.openai.monthUsd != null ? Number(d.openai.monthUsd) : null;
    orgSpend.anthropicErr = (d.anthropic && d.anthropic.error) || null;
    orgSpend.openaiErr = (d.openai && d.openai.error) || null;
    credits.openai = d.openai && d.openai.creditUsd != null ? Number(d.openai.creditUsd) : null;
    credits.openaiErr = (d.openai && d.openai.creditError) || null;
    credits.anthropicNote = (d.anthropic && d.anthropic.creditNote) || "";
    if (d.venice) {
      credits.venice = { usd: d.venice.usd != null ? Number(d.venice.usd) : null, vcu: d.venice.vcu != null ? Number(d.venice.vcu) : null, diem: d.venice.diem != null ? Number(d.venice.diem) : null };
      if (credits.venice.usd != null) veniceUsd = credits.venice.usd;
    }
  } catch {}
  updateMeters();
}
// Non-token costs (image renders) — same countdown path as token usage.
function addFlatSpend(provider, usd) {
  if (!usd) return;
  sessionSpend += usd;
  if (acctBal[provider] != null) { acctBal[provider] = Math.max(0, acctBal[provider] - usd); pushBalance(provider); }
  updateMeters();
}
function addSpend(model, inTok, outTok) {
  const p = priceFor(model);
  const cost = (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
  sessionSpend += cost;
  const prov = /gpt|chatgpt|^o[0-9]/.test((model || "").toLowerCase()) ? "openai" : "anthropic";
  if (acctBal[prov] != null) { acctBal[prov] = Math.max(0, acctBal[prov] - cost); pushBalance(prov); }
  updateMeters();
}
const fmtUsd = (v) => "$" + Number(v).toFixed(2);
const fmtSpend = (v) => "$" + (v >= 1 ? v.toFixed(2) : v.toFixed(3));
function updateMeters() {
  const parts = [];
  const balHint = (p) => `counted down from the balance you set in Connections — every panel chat, board ask, prompt-write and render is charged. Exact: $${(acctBal[p] || 0).toFixed(4)}`;
  // Priority: real REMAINING credit > real month spend > the balance you set by hand.
  if (orgSpend.anthropic != null) parts.push(`<span title="Anthropic org spend this month — live from the cost API. ${esc(credits.anthropicNote)}">claude spent <b>${fmtSpend(orgSpend.anthropic)}</b> this mo</span>`);
  else if (orgSpend.anthropicErr) parts.push(`<span title="${esc(orgSpend.anthropicErr)}" style="color:var(--red);opacity:.8">claude spend ⚠</span>`);
  else parts.push(acctBal.anthropic != null
    ? `<span title="${balHint("anthropic")}">claude <b>${fmtUsd(acctBal.anthropic)}</b> left</span>`
    : `<span title="For LIVE spend, add an Anthropic ADMIN key in Connections. Or set a balance and the studio counts down from real usage." style="opacity:.7">claude — set balance</span>`);
  if (credits.openai != null) parts.push(`<span title="OpenAI credits REMAINING — live from the billing credit-grants endpoint">gpt <b>${fmtUsd(credits.openai)}</b> credits</span>`);
  else if (orgSpend.openai != null) parts.push(`<span title="OpenAI org spend this month — live from the cost API${credits.openaiErr ? " · credits: " + esc(credits.openaiErr) : ""}">gpt spent <b>${fmtSpend(orgSpend.openai)}</b> this mo</span>`);
  else if (orgSpend.openaiErr) parts.push(`<span title="${esc(orgSpend.openaiErr)}" style="color:var(--red);opacity:.8">gpt spend ⚠</span>`);
  else parts.push(acctBal.openai != null
    ? `<span title="${balHint("openai")}">gpt <b>${fmtUsd(acctBal.openai)}</b> left</span>`
    : `<span title="For LIVE spend, add an OpenAI ADMIN key in Connections. Or set a balance and the studio counts down from real usage." style="opacity:.7">gpt — set balance</span>`);
  if (sessionSpend > 0) parts.push(`<span title="Claude + GPT cost this session — panel chats, board asks, prompt-writing and GPT-image renders (renders are close estimates). Exact: $${sessionSpend.toFixed(4)}">session ~<b>${fmtSpend(sessionSpend)}</b></span>`);
  if (veniceUsd != null) {
    const v = credits.venice, extra = [];
    if (v.vcu != null) extra.push(v.vcu.toFixed(v.vcu < 100 ? 1 : 0) + " VCU");
    if (v.diem != null) extra.push(v.diem.toFixed(v.diem < 100 ? 1 : 0) + " DIEM");
    parts.push(`<span title="Venice credit remaining — live from the Venice API${extra.length ? " · " + extra.join(" · ") : ""}">venice <b>$${veniceUsd.toFixed(2)}</b> left${extra.length ? ` <span style="opacity:.65">(${extra.join(" · ")})</span>` : ""}</span>`);
  }
  // ArtCraft credits remaining (only meaningful once its server-side wall clears).
  if (artcraftState === "connected" && artcraftCredits != null) parts.push(`<span title="ArtCraft credits remaining">artcraft <b>${fmtCredits(artcraftCredits)}</b> left</span>`);
  else if (artcraftState === "connected") parts.push(`<span title="ArtCraft is connected but its credit balance can't be read server-side yet">artcraft <b>connected</b></span>`);
  else if (artcraftState === "blocked") parts.push(`<span title="ArtCraft key saved, but the API is not reachable server-side (parked)">artcraft <b>parked</b></span>`);
  $("meters").innerHTML = parts.join("");
}
function fmtCredits(c) { const n = Number(c); return (Number.isFinite(n) ? (n >= 100 ? Math.round(n) : n.toFixed(1)) : c) + " cr"; }

// Live provider status dots at the top: green=live, red=connected-but-down, grey=no key.
const PROV_LABELS = { claude: "CLAUDE", gpt: "GPT", venice: "VENICE", artcraft: "ARTCRAFT" };
function renderStatus(providers) {
  const box = $("provStatus"); if (!box) return;
  const order = ["claude", "gpt", "venice", "artcraft"];
  box.innerHTML = order.map((k) => {
    const p = providers && providers[k];
    let cls = "o", tip = "not connected";
    if (p && p.connected && p.live) { cls = "g"; tip = "live" + (p.usd != null ? ` · $${Number(p.usd).toFixed(2)}` : ""); }
    else if (p && p.connected) { cls = "r"; tip = "down" + (p.note ? " · " + p.note : ""); }
    return `<span class="ps" title="${esc(PROV_LABELS[k])}: ${esc(tip)}"><span class="dot ${cls}"></span>${PROV_LABELS[k]}</span>`;
  }).join("");
  // Sync ArtCraft/Venice meter state from the same probe.
  if (providers) {
    if (providers.venice && providers.venice.usd != null) { veniceUsd = Number(providers.venice.usd); }
    const a = providers.artcraft;
    if (!a || !a.connected) artcraftState = "off";
    else if (a.live) artcraftState = "connected";
    else artcraftState = "blocked";
    updateMeters();
  }
}
async function loadStatus() {
  const box = $("provStatus"); if (box) box.innerHTML = `<span class="ps" style="opacity:.6">checking…</span>`;
  try { const d = await api("/api/status"); renderStatus(d.providers || {}); }
  catch { if (box) box.innerHTML = `<span class="ps" title="status check failed"><span class="dot o"></span>status?</span>`; }
}

/* auth */
async function login() {
  $("loginMsg").textContent = "…";
  try {
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: $("u").value, password: $("p").value }) });
    const d = await r.json();
    if (!d.ok) { $("loginMsg").textContent = d.error || "login failed"; return; }
    token = d.token; localStorage.setItem(TOKEN_KEY, token); showApp();
  } catch (e) { $("loginMsg").textContent = String(e); }
}
function logout() { token = ""; localStorage.removeItem(TOKEN_KEY); colConvos = {}; loadedConvos.clear(); hide("app"); show("login"); }
async function showApp() {
  hide("login"); show("app"); $("operator").textContent = "operator: " + userFromToken(token);
  applyLaneToggles();
  renderSpace();                     // kick the board load off immediately: anything dropped
                                     // during startup must have a promise to wait on
  await Promise.all([loadProjects(), loadModels()]);
  await loadThreads();
  if (!threadById(chatThread)) chatThread = (threads[0] && threads[0].id) || "__raw";
  await setThread(chatThread);
  try { if (localStorage.getItem("plx-threadbar") === "0") $("chatView").classList.add("tb-collapsed"); } catch {}
  setScreen(localStorage.getItem("plx-screen") === "chat" ? "chat" : "board");
  loadCredits(); loadStatus(); loadBalances(); loadSpend();
}

/* ---- Dual Mind panel (v53): one collapsible chat thread on the left; Space is the stage ---- */
let chatThread = localStorage.getItem("plx-thread") || "__raw";
let chatAtts = [], chatBusy = false;
function renderChatAtts() {
  const box = $("chatAtts"); if (!box) return; box.innerHTML = "";
  chatAtts.forEach((a, i) => { const el = document.createElement("div"); el.className = "att"; el.innerHTML = `<img src="${a.dataUrl}"><button class="x">✕</button>`; el.querySelector(".x").onclick = () => { chatAtts.splice(i, 1); renderChatAtts(); }; box.appendChild(el); });
}
/* Two full-screen workspaces. Exactly one owns the window; the choice is remembered. */
function setScreen(name) {
  const s = name === "chat" ? "chat" : "board";
  document.body.dataset.screen = s;
  $("scrChat").classList.toggle("on", s === "chat");
  $("scrBoard").classList.toggle("on", s === "board");
  try { localStorage.setItem("plx-screen", s); } catch {}
  if (s === "board") renderSpace();
  else { chatScrollBottom(); const ta = $("chatText"); if (ta) ta.focus(); }
}
/* Auto-scroll rule: only stick to the bottom when the reader is ALREADY there.
   Scroll up mid-stream and the view stays put — a "↓ latest" button appears instead. */
const CHAT_STICK = 150;
function chatAtBottom() { const el = $("chatTurns"); return !el || el.scrollHeight - el.scrollTop - el.clientHeight < CHAT_STICK; }
function chatScrollBottom() { const el = $("chatTurns"); if (el) el.scrollTop = el.scrollHeight; chatJumpUpd(); }
function chatJumpUpd() { const b = $("chatJump"); if (b) b.classList.toggle("hide", chatAtBottom()); }
function chatStick(wasAtBottom) { if (wasAtBottom) { const el = $("chatTurns"); if (el) el.scrollTop = el.scrollHeight; } chatJumpUpd(); }
/* ---- THREADS ----------------------------------------------------------------
   A thread is one conversation on one topic: renamable, deletable, kept forever.
   A PROJECT is a different thing — a container of rules/skills/reference. A thread
   may belong to a project, and then every message in it inherits that context.
   Thread ids double as conversation keys, so legacy ids ("__raw", old project ids)
   keep their history with no migration. -------------------------------------- */
let threads = [];
const threadById = (id) => threads.find((t) => t.id === id) || null;
const threadProjectId = (id) => { const t = threadById(id); return t && t.projectId && projects.some((p) => p.id === t.projectId) ? t.projectId : null; };

async function loadThreads() {
  try { const d = await api("/api/threads"); threads = d.threads || []; } catch { threads = []; }
  if (!threads.length) await migrateThreads();
  renderThreads();
}
// First run on an account: adopt whatever conversations already exist so no history is
// orphaned — the raw chat, plus one thread per chat project (thread id = project id).
async function migrateThreads() {
  const seeds = [{ forceId: "__raw", title: "Raw dual chat", projectId: null }];
  for (const p of projects.filter((x) => x.type === "chat")) seeds.push({ forceId: p.id, title: p.name, projectId: p.id });
  for (const sd of seeds) { try { const d = await api("/api/threads", sd); threads = d.threads || threads; } catch {} }
}
function renderThreads() {
  const box = $("threadList"); if (!box) return;
  box.innerHTML = "";
  const cnt = $("thCount"); if (cnt) cnt.textContent = threads.length + (threads.length === 1 ? " thread" : " threads");
  // group: one section per project that owns threads, then everything unfiled
  const groups = [];
  for (const p of projects) {
    const mine = threads.filter((t) => t.projectId === p.id);
    if (mine.length) groups.push({ id: p.id, name: p.name, items: mine });
  }
  const loose = threads.filter((t) => !t.projectId || !projects.some((p) => p.id === t.projectId));
  if (loose.length) groups.push({ id: null, name: "No project", items: loose });
  if (!groups.length) { box.innerHTML = '<div class="empty" style="padding:16px 8px">No threads yet — start one.</div>'; return; }

  for (const g of groups) {
    const h = document.createElement("div"); h.className = "tb-grp";
    h.innerHTML = g.id ? `<span class="pj">▣</span><span>${esc(g.name)}</span>` : `<span>${esc(g.name)}</span>`;
    if (g.id) {
      const add = document.createElement("button"); add.className = "add"; add.textContent = "＋"; add.title = "new thread in this project";
      add.onclick = (e) => { e.stopPropagation(); newThread(g.id); };
      h.appendChild(add);
    }
    box.appendChild(h);
    for (const t of g.items) {
      const el = document.createElement("div"); el.className = "thitem" + (t.id === chatThread ? " on" : "");
      el.innerHTML = `<span class="nm">${esc(t.title || "Untitled")}</span>`;
      el.title = t.title || "Untitled";
      el.onclick = () => setThread(t.id);
      const ed = document.createElement("button"); ed.className = "x"; ed.textContent = "✎"; ed.title = "rename";
      ed.onclick = (e) => { e.stopPropagation(); renameThread(t.id); };
      const del = document.createElement("button"); del.className = "x"; del.textContent = "🗑"; del.title = "delete this thread";
      del.onclick = (e) => { e.stopPropagation(); deleteThread(t.id); };
      el.appendChild(ed); el.appendChild(del); box.appendChild(el);
    }
  }
}
/* ---- Music Video template (v63) -------------------------------------------
   One click lays out the whole pipeline: a project carrying the song/video/director
   skills, a thread to plan in, and a board whose first three nodes ARE the steps —
   so the flow is visible instead of documented. -------------------------------- */
const MV_INSTRUCTIONS = `This project makes a MUSIC VIDEO: one song, one key visual, and a chain of short
Seedance clips cut to it.

Honour these throughout:
- Clips are short (5-15s). Work out shot length from the song's BPM so cuts land on bars:
  one bar in 4/4 = 240 / BPM seconds. Say the bar math when you recommend a length.
- A music reference is capped at 15 SECONDS. Never suggest feeding a whole song into one
  generation. Clip 1 carries the audio reference to establish the rhythm; later clips chain
  from the previous clip's final frame WITHOUT audio, so they stay seamless.
- Seedance generates its own audio; the reference steers timing and feel. The real track is
  laid over the finished clips at the end, outside this app.
- Carry continuity forward in every shot: character, wardrobe, lighting, grade, lens,
  location, weather, and any state established earlier. Describe only the new action.`;

async function newMusicVideo() {
  const name = (prompt("Name this music video:", "Untitled music video") || "").trim();
  if (!name) return;
  toast("setting up…");
  try {
    // 1. the project, carrying the skills that shape every thread and render inside it
    const want = ["music-video-director", "suno-prompter", "seedance-prompter-v3"];
    if (!_skillsMeta) { try { const d = await api("/api/skills"); _skillsMeta = d.skills || []; } catch { _skillsMeta = []; } }
    const have = want.filter((id) => (_skillsMeta || []).some((sk) => sk.id === id));
    const pr = await api("/api/projects", { name, type: "chat", instructions: MV_INSTRUCTIONS, attachedSkills: have });
    if (!pr.ok) { toast(pr.error || "couldn't create the project"); return; }
    const pid = (pr.project && pr.project.id) || pr.id;
    await loadProjects();

    // 2. a thread to plan in
    const th = await api("/api/threads", { title: name + " — plan", projectId: pid });
    threads = th.threads || threads;

    // 3. a board whose nodes ARE the instructions
    const bd = await api("/api/boards", { name, projectId: pid, board: { nodes: [], edges: [], pan: { x: 60, y: 40 }, zoom: 1, updatedAt: Date.now() } });
    cvBoards = bd.boards || cvBoards;
    await cvOpenBoard(bd.id);

    const step1 = { id: cvId(), kind: "text", x: 60, y: 60, w: 360, skills: have.slice(),
      text: "STEP 1 — THE SONG\nDescribe the track you want (genre, mood, BPM, length) and press Ask. You'll get a Suno prompt back. Make the song in Suno, then bring the mp3 back here." };
    const step2 = { id: cvId(), kind: "prompt", out: "image", x: 470, y: 60, w: 320, aspect: "16:9", iq: "medium", parentId: step1.id, skills: have.slice(),
      text: "STEP 2 — THE KEY VISUAL: describe your character / world here, then Generate." };
    const step3 = { id: cvId(), kind: "text", x: 870, y: 60, w: 360, skills: [],
      text: "STEP 3 — ANIMATE IT TO THE MUSIC\nHover your generated image, drag the ＋ handle off it and pick Video generator.\nOn that node, drop your song into the 🎵 MUSIC box — if it's longer than 15s you can slide to pick which part to use.\nGenerate, then hover the finished clip and press ⏭ continue to chain the next shot (leave music off those so they stay seamless)." };
    cv.nodes.push(step1, step2, step3);
    cv.edges.push({ from: step1.id, to: step2.id });
    cvSave(); cvRebuildAll();

    hide("projModal");
    setScreen("board");
    await setThread(th.thread.id);
    toast("music video set up — follow the three steps on the board");
  } catch (e) { toast("setup failed: " + String(e.message || e).slice(0, 120)); }
}

async function newThread(projectId) {
  try {
    const d = await api("/api/threads", { title: "New chat", projectId: projectId || null });
    threads = d.threads || threads;
    setScreen("chat");
    await setThread(d.thread.id);
    toast(projectId ? "new thread in this project" : "new thread");
  } catch { toast("couldn't create the thread"); }
}
async function renameThread(id) {
  const t = threadById(id); if (!t) return;
  const name = (prompt("Rename thread:", t.title || "") || "").trim(); if (!name) return;
  try { const d = await api("/api/threads", { id, title: name }); threads = d.threads || threads; renderThreads(); paintThreadHead(); toast("renamed"); }
  catch { toast("rename failed"); }
}
async function deleteThread(id) {
  const t = threadById(id); if (!t) return;
  if (!confirm(`Delete thread “${t.title || "Untitled"}”? Its messages go with it; gallery media stays.`)) return;
  try {
    const d = await api("/api/threads?id=" + encodeURIComponent(id), null, "DELETE");
    threads = d.threads || threads.filter((x) => x.id !== id);
    delete colConvos[id]; loadedConvos.delete(id);
    if (chatThread === id) { if (threads.length) await setThread(threads[0].id); else await newThread(null); }
    else { renderThreads(); }
    toast("thread deleted");
  } catch { toast("delete failed"); }
}
// Name a brand-new thread after its first message, the way a good notebook titles itself.
async function autoTitleThread(id, firstText) {
  const t = threadById(id); if (!t || !firstText) return;
  if (t.title && t.title !== "New chat" && t.title !== "Raw dual chat") return;
  const title = firstText.replace(/\s+/g, " ").trim().slice(0, 48);
  if (!title) return;
  try { const d = await api("/api/threads", { id, title }); threads = d.threads || threads; renderThreads(); paintThreadHead(); } catch {}
}
function paintThreadHead() {
  const t = threadById(chatThread);
  const ttl = $("chatTitle"); if (ttl) ttl.textContent = (t && t.title) || "DUAL MIND";
  const pj = $("chatProj"); if (!pj) return;
  const p = t && t.projectId ? projects.find((x) => x.id === t.projectId) : null;
  pj.classList.toggle("hide", !p);
  if (p) pj.textContent = "▣ " + p.name + " · rules & skills apply";
}
async function setThread(id) {
  chatThread = id; try { localStorage.setItem("plx-thread", id); } catch {}
  renderThreads(); paintThreadHead();
  await loadConvo(id);
  renderChatStream();
}
// Group the flat conversation into turns: one prompt, then each mind's answer in its own lane.
function chatGroupTurns(conv) {
  const turns = []; let cur = null;
  for (const t of conv) {
    if (t.who === "user") { cur = { q: t, claude: [], gpt: [] }; turns.push(cur); }
    else { if (!cur) { cur = { q: null, claude: [], gpt: [] }; turns.push(cur); } if (cur[t.who]) cur[t.who].push(t); }
  }
  return turns;
}
// Build one turn row. Returns the element plus its two lane cells so a live
// stream can write straight into them.
function chatTurnEl(userTurn) {
  const el = document.createElement("div"); el.className = "turn";
  if (userTurn) { const q = document.createElement("div"); q.className = "turn-q"; q.appendChild(bubbleFor(userTurn)); el.appendChild(q); }
  const a = document.createElement("div"); a.className = "turn-a";
  const claude = document.createElement("div"); claude.className = "lane claude";
  const gpt = document.createElement("div"); gpt.className = "lane gpt";
  a.appendChild(claude); a.appendChild(gpt); el.appendChild(a);
  return { el, claude, gpt };
}
function renderChatStream() {
  const el = $("chatTurns"); if (!el) return;
  const conv = colConvos[chatThread] || [];
  el.innerHTML = "";
  if (!conv.length) {
    el.innerHTML = '<div class="empty">Ask once — both minds answer side by side.<br><br>Claude on the left, ChatGPT on the right. Use <b>Collab</b> to have Claude answer first and ChatGPT build on it.</div>';
    chatJumpUpd(); return;
  }
  for (const t of chatGroupTurns(conv)) {
    const row = chatTurnEl(t.q);
    for (const m of t.claude) row.claude.appendChild(bubbleFor(m));
    for (const m of t.gpt) row.gpt.appendChild(bubbleFor(m));
    el.appendChild(row.el);
  }
  chatScrollBottom();
}
async function panelSend(collab) {
  if (chatBusy) return;
  const ta = $("chatText"); const text = ta.value.trim();
  const atts = chatAtts.slice();
  if (!text && !atts.length) return;
  chatBusy = true; const st = $("chatStatus"); st.textContent = collab ? "collaborating…" : "streaming…"; ta.value = "";
  chatAtts = []; renderChatAtts();
  const wrap = $("chatTurns");
  clearEmpty(wrap);
  const turn = { who: "user", text, images: atts.map((a) => ({ media_type: a.media_type, data: a.data })), thumbs: atts.map((a) => a.dataUrl) };
  colConvos[chatThread] = colConvos[chatThread] || []; colConvos[chatThread].push(turn);
  const row = chatTurnEl(turn);
  wrap.appendChild(row.el); chatScrollBottom();
  try {
    const both = laneOn.claude && laneOn.gpt;
    if (collab && both) {
      await streamCol("claude", $("mClaude").value, chatThread, row.claude);
      const last = [...colConvos[chatThread]].reverse().find((t) => t.who === "claude");
      const extra = last ? `Claude (the other mind) responded:\n\n${last.text}\n\nGive your own take — agree, disagree, or build on it.` : null;
      await streamCol("gpt", $("mGpt").value, chatThread, row.gpt, extra);
    } else {
      const jobs = [];
      if (laneOn.claude) jobs.push(streamCol("claude", $("mClaude").value, chatThread, row.claude));
      if (laneOn.gpt) jobs.push(streamCol("gpt", $("mGpt").value, chatThread, row.gpt));
      await Promise.all(jobs);
    }
  } finally { chatBusy = false; st.textContent = ""; saveConvo(chatThread); autoTitleThread(chatThread, text); }
}
function applyLaneToggles() {
  $("togClaude").classList.toggle("on", laneOn.claude); $("togClaude").classList.toggle("off", !laneOn.claude);
  $("togGpt").classList.toggle("on", laneOn.gpt); $("togGpt").classList.toggle("off", !laneOn.gpt);
  const cv = $("chatView");
  if (cv) { cv.classList.toggle("no-claude", !laneOn.claude); cv.classList.toggle("no-gpt", !laneOn.gpt); }
}
function toggleLane(which) {
  if (laneOn[which] && !laneOn[which === "claude" ? "gpt" : "claude"]) { toast("keep at least one lane on"); return; }
  laneOn[which] = !laneOn[which]; localStorage.setItem("plx-lanes", JSON.stringify(laneOn)); applyLaneToggles();
}

/* models (chat, global) */
async function loadModels() { await Promise.all([fillModels("claude", "mClaude", "mClaudeState"), fillModels("gpt", "mGpt", "mGptState")]); }
async function fillModels(provider, selId, stateId) {
  const sel = $(selId), st = $(stateId); st.textContent = "…";
  try {
    const d = await api("/api/models?provider=" + provider);
    if (!d.ok) throw new Error(d.error || "detect failed");
    const saved = localStorage.getItem(MODEL_KEYS[provider]) || ""; sel.innerHTML = "";
    for (const m of d.models) { const o = document.createElement("option"); o.value = m.id; o.textContent = m.label || m.id; if (m.id === saved) o.selected = true; sel.appendChild(o); }
    if (sel.value) localStorage.setItem(MODEL_KEYS[provider], sel.value);
    sel.onchange = () => localStorage.setItem(MODEL_KEYS[provider], sel.value);
    st.textContent = d.models.length + (d.models.length === 1 ? " model" : " models");
    st.title = d.models.length + " " + (provider === "claude" ? "Claude" : "OpenAI") + " models available to your key — pick one in the dropdown";
  } catch (e) { sel.innerHTML = '<option value="">— none —</option>'; st.textContent = String(e.message || e).slice(0, 20); }
}

/* projects */
async function loadProjects() { const d = await api("/api/projects"); projects = d.projects || []; renderProjects(); }
function renderProjects() {
  renderThreads();
  const cnt = $("projCount"); if (cnt) cnt.textContent = projects.length;
  const box = $("projList"); if (!box) return; box.innerHTML = "";
  if (!projects.length) { box.innerHTML = '<div class="empty" style="margin:14px 0">No projects yet — create one, or add a skill from the library.</div>'; return; }
  for (const p of projects) {
    const nSk = (p.attachedSkills || []).length;
    const nTh = threads.filter((t) => t.projectId === p.id).length;
    const el = document.createElement("div"); el.className = "pitem" + (threadProjectId(chatThread) === p.id ? " on" : "");
    el.innerHTML = `<span class="nm">${esc(p.name)}</span>`
      + `<span class="badge t" title="skills attached to this project — they shape every thread and render inside it">⚡ ${nSk}</span>`
      + `<span class="badge" title="chat threads filed under this project">💬 ${nTh}</span>`
      + (p.author ? `<span class="badge author">${esc(p.author)}</span>` : "");
    el.title = "open this project — its newest thread and its board, with its rules and skills applied";
    el.onclick = async () => {
      hide("projModal");
      const mine = threads.filter((t) => t.projectId === p.id);
      if (mine.length) { setScreen("chat"); await setThread(mine[0].id); }
      else await newThread(p.id);
      await cvOpenProjectBoard(p);
    };
    const addT = document.createElement("button"); addT.className = "x"; addT.textContent = "💬"; addT.title = "start a new thread in this project";
    addT.onclick = (e) => { e.stopPropagation(); hide("projModal"); newThread(p.id); };
    el.appendChild(addT);
    const ed = document.createElement("button"); ed.className = "x"; ed.textContent = "✎"; ed.title = "rename / edit";
    ed.onclick = (e) => { e.stopPropagation(); hide("projModal"); openEdit(p); };
    const x = document.createElement("button"); x.className = "x"; x.textContent = "🗑"; x.title = "delete project";
    x.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete “${p.name}”? Its saved conversation goes too; gallery media stays.`)) return;
      await api("/api/projects?id=" + p.id, null, "DELETE");
      // keep the conversations: just detach their threads so nothing is lost
      for (const t of threads.filter((x) => x.projectId === p.id)) {
        try { const d = await api("/api/threads", { id: t.id, projectId: null }); threads = d.threads || threads; } catch {}
      }
      await loadProjects(); renderThreads(); paintThreadHead();
      toast("project deleted — its threads kept, now unfiled");
    };
    el.appendChild(ed); el.appendChild(x); box.appendChild(el);
  }
}
function openEdit(p) { editingId = p.id; $("npName").value = p.name; $("npType").value = p.type; $("npInstr").value = p.instructions || ""; $("npTitle").textContent = "EDIT PROJECT"; fillNpSkills(p.attachedSkills || []); show("npModal"); }

// Populate the "ADD SKILLS" checkbox list in the project modal. Fetches the skills
// catalog (metadata only) once and caches it; `selected` marks which are pre-checked.
let _skillsMeta = null;
async function fillNpSkills(selected) {
  const box = $("npSkills"); if (!box) return;
  const sel = new Set(selected || []);
  box.innerHTML = '<div style="color:var(--dim);font-size:11px">loading skills…</div>';
  if (!_skillsMeta) { try { const d = await api("/api/skills"); _skillsMeta = d.skills || []; } catch { _skillsMeta = []; } }
  if (!_skillsMeta.length) { box.innerHTML = '<div style="color:var(--dim);font-size:11px">No skills in the library.</div>'; return; }
  box.innerHTML = "";
  for (const s of _skillsMeta) {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer";
    row.innerHTML = `<input type="checkbox" value="${esc(s.id)}" ${sel.has(s.id) ? "checked" : ""} style="width:auto"><span>${esc(s.name)}</span><span class="badge author" style="font-size:9px">${esc(s.author || "")}</span><span style="color:var(--dim);font-size:10px">${esc(s.type || "")}</span>`;
    box.appendChild(row);
  }
}
function selectedNpSkills() { return [...$("npSkills").querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value); }

async function saveNP() {
  const wasEdit = !!editingId;
  const body = { name: $("npName").value.trim(), type: $("npType").value, instructions: $("npInstr").value, attachedSkills: selectedNpSkills() };
  if (!body.name) { toast("name required"); return; }
  if (editingId) body.id = editingId;
  const d = await api("/api/projects", body);
  if (d.ok) { hide("npModal"); editingId = null; await loadProjects(); toast(wasEdit ? "Saved" : "Project created"); }
  else toast(d.error || "failed");
}

/* chat bubbles (shared by the Dual Mind panel and board text nodes) */
function bubbleFor(t) {
  const w = document.createElement("div");
  if (t.who === "user") {
    w.className = "msg user";
    const thumbs = (t.thumbs && t.thumbs.length) ? `<div class="atts" style="margin-top:6px;margin-bottom:0">${t.thumbs.map((u) => `<div class="att"><img src="${u}"></div>`).join("")}</div>` : "";
    w.innerHTML = `<div class="who">YOU</div><div class="bub">${esc(t.text)}${thumbs}</div>`;
  } else { w.className = "msg " + t.who; w.innerHTML = `<div class="who">${t.who === "claude" ? "CLAUDE" : "CHATGPT"} <button class="copybtn">COPY</button></div><div class="bub">${esc(t.text)}</div>`; w.querySelector(".copybtn").onclick = () => copyText(t.text); }
  return w;
}
async function streamCol(provider, model, id, streamEl, extraUser) {
  const w = document.createElement("div"); w.className = "msg " + provider;
  w.innerHTML = `<div class="who">${provider === "claude" ? "CLAUDE" : "CHATGPT"} <button class="copybtn">COPY</button></div><div class="bub"></div>`;
  const wasBottom = chatAtBottom();
  streamEl.appendChild(w); chatStick(wasBottom); const bub = w.querySelector(".bub");
  const conv = colConvos[id] || [];
  const messages = conv.filter((t) => t.who === "user" || t.who === provider).map((t) => {
    if (t.who === "user" && t.images && t.images.length) {
      const c = t.images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }));
      c.push({ type: "text", text: t.text });
      return { role: "user", content: c };
    }
    return { role: t.who === "user" ? "user" : "assistant", content: t.text };
  });
  if (extraUser) messages.push({ role: "user", content: extraUser });
  const payload = { provider, model, messages };
  const pid = threadProjectId(id); if (pid) payload.projectId = pid;   // project context, not the thread id
  let res; try { res = await fetch("/api/chat", { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) }); }
  catch (e) { w.className = "msg err"; bub.textContent = "⚠ network error: " + e; return; }
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "", errored = false;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      const t = line.trim(); if (!t.startsWith("data:")) continue; const data = t.slice(5).trim(); if (data === "[DONE]") continue;
      let evt; try { evt = JSON.parse(data); } catch { continue; }
      if (evt.delta) { const atB = chatAtBottom(); bub.textContent += evt.delta; chatStick(atB); }
      else if (evt.usage) { addSpend(model, evt.usage.input || 0, evt.usage.output || 0); }
      else if (evt.error) { errored = true; w.className = "msg err"; bub.textContent = "⚠ " + evt.error; }
    }
  }
  if (!errored && !bub.textContent) { w.className = "msg err"; bub.textContent = "⚠ (no output returned)"; }
  if (!errored && bub.textContent) colConvos[id].push({ who: provider, text: bub.textContent });
  w.querySelector(".copybtn").onclick = () => copyText(bub.textContent);
}

/* skills */
async function openSkills() {
  show("skillsModal"); const grid = $("skillsGrid"); grid.innerHTML = "loading…";
  const d = await api("/api/skills"); window._skills = d.skills || []; grid.innerHTML = "";
  // Create-your-own bar (spans the grid).
  const bar = document.createElement("div"); bar.style.cssText = "grid-column:1/-1;display:flex;align-items:center;gap:10px;margin-bottom:6px";
  bar.innerHTML = `<span style="color:var(--dim);font-size:11px;flex:1">Your custom skills and the built-in library. Build your own — it becomes attachable to any project.</span>`;
  const create = document.createElement("button"); create.className = "btn-solid"; create.textContent = "＋ CREATE SKILL"; create.onclick = openSkillEditor;
  bar.appendChild(create); grid.appendChild(bar);
  for (const s of window._skills) {
    const added = projects.find((p) => p.fromSkill === s.id); const q = s.status === "queued";
    const el = document.createElement("div"); el.className = "scard";
    el.innerHTML = `<div class="r1"><span class="nm">${esc(s.name)}</span><button class="i" title="view what makes it tick">i</button></div>` +
      `<div class="desc">${esc(s.description)}</div>` +
      `<div class="r2"><span class="badge t">${s.type}${s.subtype ? "/" + s.subtype : ""}</span><span class="badge ${s.custom ? "mine" : "author"}">${esc(s.author)}</span>` +
      (q ? '<span class="badge q">needs backend</span>' : "") + '<span style="flex:1"></span>' +
      (s.custom ? '<button class="rm skdel" title="delete this custom skill">🗑</button>' : "") +
      (added ? '<button class="rm">REMOVE</button>' : `<button class="add ${q ? "q" : ""}">＋ ADD</button>`) + "</div>";
    el.querySelector(".i").onclick = () => showInfo(s);
    const addBtn = el.querySelector(".add"); if (addBtn) addBtn.onclick = () => addSkill(s);
    const rmBtn = el.querySelector(".rm:not(.skdel)"); if (rmBtn) rmBtn.onclick = () => removeSkill(added);
    const delBtn = el.querySelector(".skdel"); if (delBtn) delBtn.onclick = () => deleteUserSkill(s);
    grid.appendChild(el);
  }
}
function openSkillEditor() {
  $("skName").value = ""; $("skType").value = "chat"; $("skAuthor").value = ""; $("skDesc").value = ""; $("skInstr").value = ""; $("skHint").textContent = "";
  show("skillEditModal");
}
async function saveUserSkill() {
  const name = $("skName").value.trim(); if (!name) { $("skHint").textContent = "give it a name"; return; }
  $("skHint").textContent = "saving…";
  const create = { name, type: $("skType").value, author: $("skAuthor").value.trim() || "you", description: $("skDesc").value.trim(), instructions: $("skInstr").value };
  const d = await api("/api/skills", { create });
  if (d.ok) { hide("skillEditModal"); _skillsMeta = null; toast(`created “${name}”`); openSkills(); }
  else { $("skHint").textContent = d.error || "create failed"; }
}
async function deleteUserSkill(s) {
  if (!confirm(`Delete your skill “${s.name}”? Projects already created from it stay.`)) return;
  const d = await api("/api/skills", { deleteSkillId: s.id });
  if (d.ok) { _skillsMeta = null; toast("skill deleted"); openSkills(); } else toast(d.error || "delete failed");
}
async function showInfo(s) {
  $("infoTitle").textContent = s.name; $("infoBody").innerHTML = "loading…"; show("infoModal");
  let full = s; try { const d = await api("/api/skills?id=" + s.id); if (d.skill) full = d.skill; } catch {}
  $("infoBody").innerHTML =
    `<div class="r2" style="margin-bottom:10px"><span class="badge t">${full.type}${full.subtype ? "/" + full.subtype : ""}</span><span class="badge author">by ${esc(full.author || "—")}</span>${full.status === "queued" ? '<span class="badge q">needs backend</span>' : ""}</div>` +
    `<div style="font-size:12px;color:var(--dim);margin-bottom:10px;white-space:pre-wrap">${esc(full.description || "")}</div>` +
    `<div class="flabel">INSTRUCTIONS — what makes it tick</div><div class="promptbox" style="max-height:300px"><button class="copybtn">COPY</button>${esc(full.instructions || "")}</div>` +
    (full.reference && full.reference.length ? `<div class="flabel">REFERENCE (${full.reference.length})</div>` + full.reference.map((r) => `<details style="margin-bottom:6px"><summary style="cursor:pointer;font-size:12px">${esc(r.title)}</summary><div class="promptbox" style="max-height:240px">${esc((r.body || "").slice(0, 6000))}</div></details>`).join("") : "");
  const cb = $("infoBody").querySelector(".copybtn"); if (cb) cb.onclick = () => copyText(full.instructions || "");
}
async function addSkill(s) {
  const d = await api("/api/skills", { skillId: s.id });
  if (d.ok) { await loadProjects(); renderThreads(); toast(`Added “${s.name}” — attach it to a project to apply it`); openSkills(); }
  else toast(d.error || "add failed");
}
async function removeSkill(p) { await api("/api/projects?id=" + p.id, null, "DELETE"); await loadProjects(); renderThreads(); openSkills(); toast("Removed"); }

/* connections */
async function openConnections() {
  show("connModal");
  try {
    const d = await api("/api/connections"); const pr = d.providers;
    $("anthropicStatus").textContent = pr.anthropic.connected ? "connected (your key)" : "using server key"; $("anthropicStatus").className = "status" + (pr.anthropic.connected ? " ok" : "");
    $("openaiStatus").textContent = pr.openai.connected ? "connected (your key)" : "using server key"; $("openaiStatus").className = "status" + (pr.openai.connected ? " ok" : "");
    const aa = $("anthropicAdminStatus"); if (aa) { aa.textContent = pr.anthropic.admin ? "admin key saved — live month spend in the top bar" : "no admin key — spend can't be read"; aa.className = "status" + (pr.anthropic.admin ? " ok" : ""); }
    const oa = $("openaiAdminStatus"); if (oa) { oa.textContent = pr.openai.admin ? "admin key saved — live month spend in the top bar" : "no admin key — spend can't be read"; oa.className = "status" + (pr.openai.admin ? " ok" : ""); }
    const v = pr.venice; $("veniceStatus").textContent = v.connected ? "connected" + (v.balance && v.balance.usd != null ? ` · $${v.balance.usd.toFixed(2)}` : "") : "not connected"; $("veniceStatus").className = "status" + (v.connected ? " ok" : "");
    const a = pr.artcraft; $("artcraftStatus").textContent = a.connected ? (a.baseSet ? "connected" : "key stored · add base URL to enable") : "not connected"; $("artcraftStatus").className = "status" + (a.connected && a.baseSet ? " ok" : "");
  } catch {}
}
async function saveProviderKey(provider, inputId) {
  const key = $(inputId).value.trim(); if (!key) return;
  const d = await api("/api/connections", { provider, key });
  if (d.ok) { $(inputId).value = ""; toast(provider.replace("_admin", " admin") + " key saved"); openConnections(); if (provider === "anthropic" || provider === "openai") loadModels(); if (/_admin$/.test(provider)) loadSpend(); loadStatus(); } else toast(d.error || "save failed");
}

/* provider credits (Venice reports a live balance; shown in the top meters) */
async function loadCredits() {
  try {
    const d = await api("/api/connections");
    const v = d.providers.venice;
    setCredits(v && v.balance ? v.balance.usd : null);
    const a = d.providers.artcraft;
    if (!a || !a.connected) { artcraftState = "off"; artcraftCredits = null; }
    else if (a.balance && a.balance.error) { artcraftState = "blocked"; artcraftCredits = null; }
    else { artcraftState = "connected"; artcraftCredits = a.balance ? (a.balance.credits != null ? a.balance.credits : null) : null; }
    updateMeters();
  } catch {}
}
function setCredits(usd) { veniceUsd = usd != null ? Number(usd) : null; updateMeters(); }

/* reference-wall dock */
function toggleRefDock() { const d = $("refDock"); if (d.classList.contains("hide")) { show("refDock"); loadRefWall(); } else hide("refDock"); }
function loadRefWallIfOpen() { if (!$("refDock").classList.contains("hide")) loadRefWall(); }
// Attach one image (base64 data URL) to the Dual Mind composer, opening the panel if closed.
function addImgToComposer(att) {
  setScreen("chat");
  chatAtts.push(att); renderChatAtts(); return true;
}
function dataUrlToAtt(dataUrl) { const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || ""); return m ? { media_type: m[1], data: m[2], dataUrl } : null; }
// Downscale a reference image before sending it to generation. A multi-MB base64 in the request
// body can blow the Cloudflare Worker's CPU/memory budget when it re-serializes to the provider
// (→ platform 502). ~1280px JPEG is plenty for a reference and keeps the payload tiny.
async function shrinkAtt(att) {
  try {
    if (!att || !att.dataUrl) return att;
    if ((att.data || "").length < 400000) return att; // already small (~<300 KB)
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = att.dataUrl; });
    const scale = Math.min(1, 1280 / Math.max(img.width || 1280, img.height || 1280));
    const w = Math.max(1, Math.round((img.width || 1280) * scale)), h = Math.max(1, Math.round((img.height || 1280) * scale));
    const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h);
    return dataUrlToAtt(c.toDataURL("image/jpeg", 0.82)) || att;
  } catch { return att; }
}

/* ---- gallery: images/videos tabs, project folders, playback, multi-select → Claude ---- */
const projName = (id) => { const p = projects.find((x) => x.id === id); return p ? p.name : null; };

async function loadRefWall() {
  const wall = $("refWall"); wall.innerHTML = '<div class="empty" style="grid-column:1/3">loading…</div>';
  try { const d = await api("/api/gallery"); galMedia = d.media || []; galFolders = d.folders || []; renderGallery(); }
  catch { wall.innerHTML = '<div class="empty" style="grid-column:1/3">gallery error</div>'; }
}
function setGalTab(t) { galTab = t; $("galTabImg").classList.toggle("on", t === "image"); $("galTabVid").classList.toggle("on", t === "video"); renderGallery(); }

function sortItems(items) {
  return items.slice().sort((a, b) => galSort === "old" ? (a.createdAt || 0) - (b.createdAt || 0) : (b.createdAt || 0) - (a.createdAt || 0));
}
function renderGallery() {
  const wall = $("refWall"); wall.innerHTML = "";
  const list = galMedia.filter((m) => (m.type || "image") === galTab);
  if (!list.length) { wall.innerHTML = `<div class="empty" style="grid-column:1/3">No ${galTab}s yet.</div>`; updateGalBar(); return; }
  const folderById = new Map(galFolders.map((f) => [f.id, f]));
  // Group: a user-created folder (if the item has one) wins; otherwise fall back to the auto per-project folder.
  const groups = new Map();
  for (const m of list) {
    const key = (m.folder && folderById.has(m.folder)) ? ("cust:" + m.folder) : (m.projectId || "__manual__");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  // Order: custom folders first (creation order), then project folders, then manual/unsorted last.
  const orderKey = (k) => k.startsWith("cust:") ? [0, galFolders.findIndex((f) => "cust:" + f.id === k)] : k === "__manual__" ? [2, 0] : [1, 0];
  const keys = [...groups.keys()].sort((a, b) => { const oa = orderKey(a), ob = orderKey(b); return oa[0] - ob[0] || oa[1] - ob[1]; });
  for (const key of keys) {
    const items = sortItems(groups.get(key));
    const isCust = key.startsWith("cust:");
    const cust = isCust ? folderById.get(key.slice(5)) : null;
    const label = isCust ? cust.name : (key === "__manual__" ? "MANUAL / UNSORTED" : (projName(key) || "(deleted project)"));
    const folded = !!galFolded[key];
    const hdr = document.createElement("div"); hdr.className = "galfolder" + (isCust ? " cust" : "");
    hdr.innerHTML = `<span>${folded ? "▸" : "▾"} 📁 ${esc(label)}</span><span class="cnt">${items.length}</span>`;
    if (isCust) {
      const del = document.createElement("button"); del.className = "gfdel"; del.textContent = "✕"; del.title = "delete folder (media stays in your gallery)";
      del.onclick = async (e) => { e.stopPropagation(); if (!confirm(`Delete folder “${cust.name}”? The media stays in your gallery — just un-filed.`)) return; await api("/api/gallery", { action: "folders.delete", id: cust.id }); toast("folder deleted"); loadRefWall(); };
      hdr.appendChild(del);
    }
    hdr.onclick = () => { galFolded[key] = !folded; renderGallery(); };
    wall.appendChild(hdr);
    if (folded) continue;
    for (const m of items) wall.appendChild(galTile(m));
  }
  updateGalBar();
}
async function createFolder() {
  const name = (prompt("New folder name:") || "").trim(); if (!name) return;
  const d = await api("/api/gallery", { action: "folders.create", name });
  if (d && d.folders) { galFolders = d.folders; toast("folder created"); renderGallery(); }
}
async function moveSelectedTo(v) {
  const ids = Object.keys(galSel); if (!ids.length || !v) { renderGallery(); return; }
  let folder = v;
  if (v === "__none") folder = null;
  else if (v === "__new") {
    const name = (prompt("New folder name:") || "").trim(); if (!name) { renderGallery(); return; }
    const d = await api("/api/gallery", { action: "folders.create", name });
    if (!d || !d.folders) { toast("couldn't create folder"); return; }
    galFolders = d.folders; folder = d.id;
  }
  await api("/api/gallery", { action: "media.move", ids, folder });
  const set = new Set(ids); galMedia.forEach((m) => { if (set.has(m.id)) m.folder = folder; });
  galSel = {}; toast(`moved ${ids.length} item${ids.length > 1 ? "s" : ""}`); renderGallery();
}
// Route one image attachment: "chat" → Dual Mind composer, "board" → a node on the Space.
function sendMediaTo(target, att) {
  if (!att) return false;
  if (target === "board") { setScreen("board"); cvLoad(); const c = cvCenter(); cvAddImage(att.dataUrl, att.galleryId || null, c.x, c.y); toast("image on the board"); return true; }
  return addImgToComposer(att);
}

function galTile(m) {
  const t = document.createElement("div"); t.className = "rtile" + (galSel[m.id] ? " sel" : "");
  t.title = m.type === "video" ? "click to play · checkbox to select" : "click to view · checkbox to select";
  const chk = document.createElement("input"); chk.type = "checkbox"; chk.className = "rsel"; chk.checked = !!galSel[m.id];
  chk.onclick = (e) => { e.stopPropagation(); toggleSel(m, chk.checked, t); };
  t.appendChild(chk);
  const del = document.createElement("button"); del.className = "rdel"; del.textContent = "✕"; del.title = "delete";
  del.onclick = async (e) => { e.stopPropagation(); delete galSel[m.id]; await api("/api/gallery?id=" + m.id, null, "DELETE"); loadRefWall(); };
  t.appendChild(del);
  if (m.type === "video") { const b = document.createElement("div"); b.className = "vbadge"; b.textContent = "▶ VIDEO"; t.appendChild(b); }
  api("/api/gallery?id=" + m.id).then((it) => {
    const src = it.dataUrl || it.url || ""; t._src = src; t._type = m.type;
    if (galSel[m.id]) galSel[m.id].src = src;
    if (!src) return;
    const media = m.type === "video" ? `<video src="${src}" muted preload="metadata"></video>` : `<img src="${src}">`;
    t.insertAdjacentHTML("afterbegin", media);
  }).catch(() => {});
  t.onclick = () => {
    if (!t._src) { toast("still loading…"); return; }
    openLightbox(m.type, t._src, m); // both images and videos open the big viewer now
  };
  // Draggable straight from the gallery into any composer / reference box.
  t.draggable = true;
  t.addEventListener("dragstart", (e) => {
    if (!t._src) { e.preventDefault(); return; }
    e.dataTransfer.setData("text/plain", t._src);
    e.dataTransfer.setData("application/x-plx-media", JSON.stringify({ type: m.type, src: t._src, id: m.id, projectId: m.projectId || null }));
  });
  return t;
}

function toggleSel(m, on, tile) {
  if (on) galSel[m.id] = { id: m.id, type: m.type, src: (tile && tile._src) || null };
  else delete galSel[m.id];
  if (tile) tile.classList.toggle("sel", on);
  updateGalBar();
}
function updateGalBar() {
  const bar = $("galBar"); const ids = Object.keys(galSel);
  if (!ids.length) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  const vids = ids.filter((id) => galSel[id].type === "video").length;
  bar.style.display = "flex";
  bar.innerHTML = `<span><b>${ids.length}</b> selected${vids ? ` · ${vids} video${vids > 1 ? "s" : ""}` : ""}</span>`;
  const mv = document.createElement("select"); mv.className = "tbtn"; mv.style.cssText = "padding:4px 6px;font-size:11px";
  mv.innerHTML = `<option value="">Move to…</option>` + galFolders.map((f) => `<option value="${esc(f.id)}">📁 ${esc(f.name)}</option>`).join("") + `<option value="__new">＋ New folder…</option><option value="__none">Unsorted</option>`;
  mv.onchange = () => moveSelectedTo(mv.value);
  bar.appendChild(mv);
  const send = document.createElement("button"); send.className = "btn-solid"; send.style.cssText = "padding:5px 10px;font-size:11px;margin-left:auto"; send.textContent = "👁 SEND TO CLAUDE";
  send.onclick = sendSelectionToClaude;
  const clr = document.createElement("button"); clr.className = "tbtn"; clr.style.cssText = "padding:5px 8px;font-size:11px"; clr.textContent = "clear";
  clr.onclick = () => { galSel = {}; renderGallery(); };
  bar.appendChild(send); bar.appendChild(clr);
}

// Lightbox — videos play looping; images open big with click-to-zoom (2x, centered on click),
// plus an "add to prompt" button so you can still pull the image into a prompt from here.
function lbBtn(label, onclick, cls) { const b = document.createElement("button"); b.className = cls || "btn-solid"; b.style.cssText = "padding:7px 12px;font-size:11.5px"; b.textContent = label; b.onclick = onclick; return b; }
function mediaExt(src, type) { const m = /^data:(?:image|video)\/([a-z0-9.+-]+)/i.exec(src || ""); if (m) { let e = m[1].toLowerCase(); if (e === "jpeg") e = "jpg"; if (e === "quicktime") e = "mov"; return e; } return type === "video" ? "mp4" : "png"; }
// Save the media to disk. Data URLs download directly; remote (Venice) URLs are fetched to a blob first.
async function downloadMedia(src, name) {
  try {
    let url = src, revoke = false;
    if (!/^data:/.test(src)) { const b = await (await fetch(src)).blob(); url = URL.createObjectURL(b); revoke = true; }
    const a = document.createElement("a"); a.href = url; a.download = name || "download"; document.body.appendChild(a); a.click(); a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("downloaded");
  } catch { toast("couldn't download — right-click the media → Save"); }
}
function openLightbox(type, src, media) {
  const body = $("lbBody");
  const item = { type, src, id: media && media.id, projectId: media && media.projectId };
  if (type === "video") {
    body.innerHTML = `<video src="${src}" controls autoplay loop playsinline style="max-width:88vw;max-height:74vh"></video>`;
    const row = document.createElement("div"); row.className = "lbrow";
    row.append(
      lbBtn("⬇ Download", () => downloadMedia(src, "parallax-video." + mediaExt(src, "video"))),
      lbBtn("→ Board", async () => { if (await routeMediaTo("board", item)) closeLightbox(); }, "btn-ghost"),
      lbBtn("→ Chat (frames)", async () => { if (await routeMediaTo("chat", item)) closeLightbox(); }, "btn-ghost"),
      lbBtn("⑂ Break into frames", () => breakIntoFrames(src, item), "btn-ghost")
    );
    body.appendChild(row);
    const fr = document.createElement("div"); fr.id = "lbFrames"; body.appendChild(fr);
  } else {
    body.innerHTML = `<img id="lbImg" src="${src}" style="max-width:88vw;max-height:74vh;cursor:zoom-in;transition:transform .15s ease">`;
    const img = body.querySelector("#lbImg"); let zoomed = false;
    img.onclick = (e) => {
      zoomed = !zoomed;
      if (zoomed) { const r = img.getBoundingClientRect(); img.style.transformOrigin = `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`; img.style.transform = "scale(2)"; img.style.cursor = "zoom-out"; }
      else { img.style.transform = "none"; img.style.cursor = "zoom-in"; }
    };
    const row = document.createElement("div"); row.className = "lbrow";
    row.append(
      lbBtn("⬇ Download", () => downloadMedia(src, "parallax-image." + mediaExt(src, "image"))),
      lbBtn("→ Chat", async () => { if (await routeMediaTo("chat", item)) closeLightbox(); }, "btn-ghost"),
      lbBtn("→ Board", async () => { if (await routeMediaTo("board", item)) closeLightbox(); }, "btn-ghost")
    );
    body.appendChild(row);
  }
  show("galLightbox");
}
function closeLightbox() { $("lbBody").innerHTML = ""; hide("galLightbox"); }

// ---- resizable side + gallery panels (drag the edge; widths persist) ----
function makeResizer(el, edge, key, min, max) {
  if (!el || el._rz) return; el._rz = true;
  el.style.position = "relative";
  const h = document.createElement("div"); h.className = "rz rz-" + edge; el.appendChild(h);
  let startX = 0, startW = 0, dragging = false;
  h.addEventListener("pointerdown", (e) => { dragging = true; startX = e.clientX; startW = el.getBoundingClientRect().width; try { h.setPointerCapture(e.pointerId); } catch {} document.body.style.cursor = "ew-resize"; h.classList.add("drag"); e.preventDefault(); });
  h.addEventListener("pointermove", (e) => { if (!dragging) return; let w = edge === "right" ? startW + (e.clientX - startX) : startW - (e.clientX - startX); w = Math.max(min, Math.min(max, w)); el.style.width = el.style.flexBasis = w + "px"; });
  const end = (e) => { if (!dragging) return; dragging = false; document.body.style.cursor = ""; h.classList.remove("drag"); try { h.releasePointerCapture(e.pointerId); } catch {} try { localStorage.setItem(key, String(Math.round(el.getBoundingClientRect().width))); } catch {} };
  h.addEventListener("pointerup", end); h.addEventListener("pointercancel", end);
}
function setupResizers() {
  const ref = $("refDock");
  makeResizer(ref, "left", "plx-w-ref", 210, 560);
  try { const wr = localStorage.getItem("plx-w-ref"); if (wr && ref) ref.style.width = ref.style.flexBasis = wr + "px"; } catch {}
}

// ---- universal media routing: any gallery item (image or video) → chat / image / video ----
async function srcToImgAtt(src) {
  if (!src) return null;
  if (/^data:image\//i.test(src)) return dataUrlToAtt(src);
  try { const b = await (await fetch(src)).blob(); return await new Promise((res) => { const r = new FileReader(); r.onload = () => res(dataUrlToAtt(String(r.result))); r.onerror = () => res(null); r.readAsDataURL(b); }); } catch { return null; }
}
// Some encoders (notably anything from MediaRecorder, and some streamed sources) report
// duration = Infinity until the file is fully scanned. Seeking far past the end forces the
// browser to clamp to — and therefore reveal — the true duration. Without this, every
// frame grab silently fell back to t=0, i.e. the FIRST frame.
function videoDurationOf(v) {
  return new Promise((res) => {
    if (isFinite(v.duration) && v.duration > 0) return res(v.duration);
    let settled = false;
    const finish = (d) => { if (settled) return; settled = true; v.removeEventListener("seeked", onSeek); res(d || 0); };
    const onSeek = () => finish(isFinite(v.duration) && v.duration > 0 ? v.duration : v.currentTime);
    v.addEventListener("seeked", onSeek);
    try { v.currentTime = 1e7; } catch { finish(0); }
    setTimeout(() => finish(isFinite(v.duration) && v.duration > 0 ? v.duration : v.currentTime), 5000);
  });
}
function seekVideo(v, t) {
  return new Promise((res) => {
    if (Math.abs(v.currentTime - t) < 0.02) return res();   // already there: no 'seeked' would fire
    let settled = false;
    const finish = () => { if (settled) return; settled = true; v.removeEventListener("seeked", finish); res(); };
    v.addEventListener("seeked", finish);
    try { v.currentTime = t; } catch { finish(); }
    setTimeout(finish, 5000);
  });
}
// Some clips carry no seek index (seekable range is [0,0] — anything MediaRecorder made,
// and some streamed sources). Seeking silently does nothing there, which would hand back
// frame 0 and make a "continuation" start from the WRONG end of the shot. When a seek
// doesn't land, play the clip up to the mark instead and grab it on the way past.
async function seekOrPlayTo(v, t) {
  await seekVideo(v, t);
  if (Math.abs(v.currentTime - t) < 0.25 || t <= 0) return true;
  return await new Promise((res) => {
    let settled = false;
    const stop = (ok) => {
      if (settled) return; settled = true;
      v.removeEventListener("timeupdate", tick); v.removeEventListener("ended", onEnd);
      try { v.pause(); } catch {}
      res(ok);
    };
    const tick = () => { if (v.currentTime >= t - 0.05) stop(true); };
    const onEnd = () => stop(true);                       // ran to the end: that IS the last frame
    v.addEventListener("timeupdate", tick); v.addEventListener("ended", onEnd);
    v.play().catch(() => stop(false));
    setTimeout(() => stop(false), Math.min(20000, (t + 2) * 1000 + 3000));
  });
}
function snapFrame(v) {
  try {
    const w = v.videoWidth || 640, h = v.videoHeight || 360, s = Math.min(1, 768 / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    return dataUrlToAtt(c.toDataURL("image/jpeg", 0.8));
  } catch { return null; }   // tainted (CORS) frame
}
function loadVideoEl(src) {
  const v = document.createElement("video");
  v.muted = true; v.crossOrigin = "anonymous"; v.preload = "auto"; v.src = src;
  return new Promise((res, rej) => {
    v.onloadedmetadata = () => res(v);
    v.onerror = () => rej(new Error("video load failed"));
    setTimeout(() => rej(new Error("video load timed out")), 15000);
  });
}

// Grab a single frame near `fraction` of the video (0.98 ≈ last frame).
async function grabVideoFrame(src, fraction) {
  try {
    const v = await loadVideoEl(src);
    const dur = await videoDurationOf(v);
    await seekOrPlayTo(v, dur ? Math.max(0, dur * fraction - 0.03) : 0);
    return snapFrame(v);
  } catch { return null; }
}
async function sendVideoFramesToChat(src) {
  toast("sampling frames…");
  const frames = await extractFrames(src, 6);
  if (!frames.length) { toast("couldn't read video (a remote URL may block frame capture)"); return false; }
  setScreen("chat");
  frames.forEach((f) => chatAtts.push(f)); renderChatAtts();
  const ta = $("chatText"); if (ta && !ta.value.trim()) ta.value = `Watch these ${frames.length} sampled frames from the clip and `;
  toast(`${frames.length} frames sent to chat`); if (ta) ta.focus();
  return true;
}
// The single router every entry point (lightbox buttons + drag-drop) calls: chat | board.
async function routeMediaTo(target, item) {
  if (!item || !item.src) return false;
  if (item.type === "video") {
    if (target === "board") { setScreen("board"); await cvWhenReady(); cvLoad(); const c = cvCenter(); cvAddVideo(item.src, item.id || null, c.x, c.y, null); toast("clip on the board"); return true; }
    return await sendVideoFramesToChat(item.src);
  }
  const att = await srcToImgAtt(item.src); if (!att) { toast("couldn't read image"); return false; }
  if (target === "board") { setScreen("board"); cvLoad(); const c = cvCenter(); await cvAddImage(att.dataUrl, item.id || null, c.x, c.y); toast("image on the board"); return true; }
  const ok = sendMediaTo("chat", att); if (ok) toast("sent to chat"); return ok;
}

// ---- video → frames panel: save frames to the gallery as images (deduped) + send any frame anywhere ----
function miniBtn(label, onclick) { const b = document.createElement("button"); b.className = "frmbtn"; b.textContent = label; if (onclick) b.onclick = onclick; return b; }
async function breakIntoFrames(src, item) {
  const wrap = $("lbFrames"); if (!wrap) return;
  wrap.innerHTML = `<div class="empty" style="padding:12px">sampling frames…</div>`;
  const frames = await extractFrames(src, 6);
  if (!frames.length) { wrap.innerHTML = `<div class="empty" style="padding:12px">couldn't read this video (a remote URL may block frame capture)</div>`; return; }
  renderFramesPanel(wrap, frames, item);
}
function renderFramesPanel(wrap, frames, item) {
  wrap.innerHTML = "";
  const grid = document.createElement("div"); grid.className = "frmgrid";
  frames.forEach((f, i) => {
    const cell = document.createElement("div"); cell.className = "frmcell";
    cell.innerHTML = `<img src="${f.dataUrl}">`;
    const savedKey = `frm:${item.id || "x"}:${i}`;
    const acts = document.createElement("div"); acts.className = "frmacts";
    acts.append(
      miniBtn("＋Chat", () => { sendMediaTo("chat", f); toast("frame → chat"); }),
      miniBtn("＋Board", () => { sendMediaTo("board", f); })
    );
    const already = localStorage.getItem(savedKey) === "1";
    const save = miniBtn(already ? "✓ saved" : "⬇ Save", null);
    if (already) save.disabled = true; else save.onclick = () => saveFrameToGallery(f, item, i, save, savedKey);
    acts.appendChild(save); cell.appendChild(acts); grid.appendChild(cell);
  });
  wrap.appendChild(grid);
  const bar = document.createElement("div"); bar.className = "frmbar";
  bar.append(
    lbBtn("⬇ Save all", async () => { for (let i = 0; i < frames.length; i++) { const k = `frm:${item.id || "x"}:${i}`; if (localStorage.getItem(k) !== "1") await saveFrameToGallery(frames[i], item, i, null, k); } toast("saved frames to gallery"); loadRefWallIfOpen(); renderFramesPanel(wrap, frames, item); }),
    lbBtn("→ All frames to Chat", async () => { setScreen("chat"); frames.forEach((f) => chatAtts.push(f)); renderChatAtts(); toast("frames sent to chat"); closeLightbox(); })
  );
  wrap.appendChild(bar);
}
async function saveFrameToGallery(frame, item, index, btn, savedKey) {
  try {
    const d = await api("/api/gallery", { dataUrl: frame.dataUrl, name: `frame ${index + 1}`, projectId: item.projectId || null });
    if (d && (d.ok || d.entry)) { localStorage.setItem(savedKey, "1"); if (btn) { btn.textContent = "✓ saved"; btn.disabled = true; } loadRefWallIfOpen(); }
    else toast((d && d.error) || "save failed");
  } catch (e) { toast("save failed: " + (e.message || e)); }
}

// Extract ~6 evenly-spaced frames from a video (client-side canvas) so Claude can "watch" it —
// the web equivalent of author's claude-watch ffmpeg step. Frames are downscaled to cap tokens.
async function extractFrames(src, n = 6) {
  const frames = [];
  try {
    const v = await loadVideoEl(src);
    const dur = await videoDurationOf(v);
    for (let i = 0; i < n; i++) {
      await seekOrPlayTo(v, dur ? (dur * (i + 0.5)) / n : 0);
      const att = snapFrame(v); if (att) frames.push(att);
      if (!dur) break;   // no duration at all: one frame is all there is to take
    }
  } catch { /* unreadable source — caller handles the empty result */ }
  return frames;
}

// Selected media -> attach to the open chat column so Claude can review. Images attach directly;
// videos are sampled into frames (audio can't be analyzed via the API — we note that).
async function sendSelectionToClaude() {
  const ids = Object.keys(galSel); if (!ids.length) return;
  setScreen("chat");
  toast("preparing media…");
  const atts = []; let vidCount = 0, frameCount = 0, imgCount = 0, failed = 0;
  for (const id of ids) {
    const it = galSel[id]; let src = it.src;
    if (!src) { try { const g = await api("/api/gallery?id=" + id); src = g.dataUrl || g.url || ""; } catch {} }
    if (!src) { failed++; continue; }
    if (it.type === "video") {
      const frames = await extractFrames(src, 6);
      if (frames.length) { frames.forEach((f) => atts.push(f)); vidCount++; frameCount += frames.length; }
      else failed++;
    } else {
      const att = dataUrlToAtt(src); if (att) { atts.push(att); imgCount++; } else failed++;
    }
  }
  if (!atts.length) { toast(failed ? "couldn't read media (a remote URL may block frame capture)" : "nothing to send"); return; }
  atts.forEach((a) => chatAtts.push(a)); renderChatAtts();
  const ta = $("chatText");
  if (ta && !ta.value.trim()) ta.value = `Watch the attached ${vidCount ? `${vidCount} clip${vidCount > 1 ? "s" : ""} (${frameCount} sampled frames)` : ""}${vidCount && imgCount ? " and " : ""}${imgCount ? `${imgCount} image${imgCount > 1 ? "s" : ""}` : ""} and give me feedback: `;
  galSel = {}; renderGallery();
  const note = vidCount ? " · video = sampled frames (no audio)" : "";
  toast(`added ${atts.length} image${atts.length > 1 ? "s" : ""} to chat${note} — type your question & send`);
  if (ta) ta.focus();
}

/* ---- Space (v41): infinite creative board — the full media graph ----
   Node kinds: image · video · text (chat) · prompt (generator).
   Drag the ＋ handle off any image/video/text node and pick what to grow from it:
   an Image generator, a Video generator, or a Text node that talks about it.
   Prompt nodes render on Venice (image = sync, video = queued + polled); text nodes
   chat over /api/chat with connected images seen and connected text remembered.
   Media persists in the KV gallery; the board keeps layout + ids in localStorage. */
const CANVAS_KEY = "plx-canvas-v1";           // legacy per-browser board (migrated to KV once)
const CANVAS_CACHE = "plx-canvas-cache";      // crash-safety copy of the current board
const BOARD_LAST = "plx-board-last";          // last-open board id (per browser)
let cv = null, cvDrag = null, cvLink = null, cvZ = 10, cvJustDragged = false, cvMenuEl = null;
let cvBoardId = null, cvBoards = [], cvBoardsReady = false, cvBoardsPromise = null, cvKvTimer = null, cvPushPending = false;
const cvEls = {};
const cvId = () => "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function cvLoad() { if (!cv) cv = { nodes: [], edges: [], pan: { x: 60, y: 40 }, zoom: 1 }; }
// Slim a board for storage: layout + gallery ids + text only. Inline image data drops
// out (it reloads from the gallery by id); a video's remote URL is kept, a data: URL is not.
function cvSlim() {
  return { ...cv, updatedAt: Date.now(), nodes: cv.nodes.map((n) => {
    const { dataUrl, src, busy, ...keep } = n; if (src && !/^data:/.test(src)) keep.src = src;
    // Ref attachments: image refs rehydrate from the gallery; audio has no server home,
    // so only its label survives a reload (the chip says to re-drop it).
    if (keep.refs) keep.refs = {
      imgs: (keep.refs.imgs || []).filter((r) => r.galleryId).map((r) => ({ galleryId: r.galleryId })),
      aud: (keep.refs.aud || []).map((r) => ({ name: r.name, dur: r.dur })),
    };
    return keep;
  }) };
}
/* Boards live in KV (/api/boards) so they follow the account onto any computer.
   Saves are debounced; a localStorage cache covers the debounce window if the tab
   dies mid-save and is reconciled (newest wins) next time the board opens. */
function cvSave() {
  const slim = cvSlim();
  try { localStorage.setItem(cvBoardId ? CANVAS_CACHE : CANVAS_KEY, JSON.stringify(cvBoardId ? { id: cvBoardId, board: slim } : slim)); } catch {}
  if (!cvBoardId) return;
  cvPushPending = true;
  clearTimeout(cvKvTimer);
  cvKvTimer = setTimeout(cvFlush, 2000);
}
function cvFlush() {
  if (!cvPushPending || !cvBoardId) return;
  cvPushPending = false; clearTimeout(cvKvTimer);
  api("/api/boards", { id: cvBoardId, board: cvSlim() }).catch(() => { cvPushPending = true; });
}
function cvView() { return $("cvView"); }
function cvWorldPt(e) { const r = cvView().getBoundingClientRect(); return { x: (e.clientX - r.left - cv.pan.x) / cv.zoom, y: (e.clientY - r.top - cv.pan.y) / cv.zoom }; }
function cvApply() { $("cvWorld").style.transform = `translate(${cv.pan.x}px,${cv.pan.y}px) scale(${cv.zoom})`; }
function cvEmptyUpd() { const e = $("cvEmpty"); if (e) e.style.display = cv.nodes.length ? "none" : "flex"; }
function cvNode(id) { return cv.nodes.find((x) => x.id === id); }

/* ---- node elements ---- */
function cvAgentOptions(sel, current) {
  for (const [prov, selId, label] of [["claude", "mClaude", "Claude"], ["gpt", "mGpt", "ChatGPT"]]) {
    const grp = document.createElement("optgroup"); grp.label = label;
    for (const o of $(selId).options) { if (!o.value) continue; const opt = document.createElement("option"); opt.value = prov + "|" + o.value; opt.textContent = o.textContent; grp.appendChild(opt); }
    if (grp.children.length) sel.appendChild(grp);
  }
  sel.value = current || ("claude|" + $("mClaude").value);
  if (!sel.value) sel.selectedIndex = 0;
}
async function cvRenderModels(prov, type) {
  const ck = prov + ":" + type;
  // Only cache a NON-empty answer: a transient failure used to be cached for the whole
  // session, which is what pinned the video picker to a lone "default".
  if (!genModelsCache[ck] || !genModelsCache[ck].length) {
    try { const d = await api(`/api/models?provider=${prov}&type=${type}`); genModelsCache[ck] = d.models || []; } catch { genModelsCache[ck] = []; }
  }
  return genModelsCache[ck];
}

/* ---- skills on nodes: attached skills ride every generation off the node and are
   inherited by everything grown from it, until toggled off. The agent is told to
   apply each one only where applicable. ---- */
const cvSkillCache = {};
async function cvSkillsMeta() {
  if (!_skillsMeta) { try { const d = await api("/api/skills"); _skillsMeta = d.skills || []; } catch { _skillsMeta = []; } }
  return _skillsMeta;
}
function cvSkillName(id) { const s = (_skillsMeta || []).find((x) => x.id === id); return s ? s.name : "skill"; }
function cvSkillsRow(n, el) {
  if (!el) return;
  let row = el.querySelector(".cvskills");
  if (!row) { row = document.createElement("div"); row.className = "cvskills"; el.appendChild(row); }
  row.innerHTML = "";
  if ((n.skills || []).length && !_skillsMeta) cvSkillsMeta().then(() => { if (cvEls[n.id] === el) cvSkillsRow(n, el); });
  for (const id of n.skills || []) {
    const c = document.createElement("span"); c.className = "cvchip"; c.title = "active skill — rides every generation off this node until turned off";
    c.innerHTML = `❋ ${esc(cvSkillName(id))}<button title="turn this skill off here">✕</button>`;
    c.querySelector("button").onclick = (e) => { e.stopPropagation(); n.skills = (n.skills || []).filter((x) => x !== id); cvSave(); cvSkillsRow(n, el); cvDrawEdges(); };
    row.appendChild(c);
  }
  const add = document.createElement("button"); add.className = "cvskadd"; add.textContent = "✚ skill";
  add.title = "attach skills — they stay active for this node and everything grown from it";
  add.onclick = (e) => { e.stopPropagation(); cvSkillPicker(e, n); };
  row.appendChild(add);
}
async function cvSkillPicker(e, n) {
  cvHideMenu();
  const view = cvView(), r = view.getBoundingClientRect();
  const m = document.createElement("div"); m.className = "cvmenu cvskmenu"; cvMenuEl = m;
  m.innerHTML = '<div class="mh">SKILLS — active ones ride every generation off this node</div>';
  m.style.left = Math.max(8, Math.min(e.clientX - r.left, r.width - 250)) + "px";
  m.style.top = Math.max(8, Math.min(e.clientY - r.top, r.height - 260)) + "px";
  view.appendChild(m);
  const list = await cvSkillsMeta();
  if (cvMenuEl !== m) return;   // closed while loading
  if (!list.length) { const d = document.createElement("div"); d.className = "mh"; d.textContent = "No skills yet — create one below."; m.appendChild(d); }
  for (const s of list) {
    const row = document.createElement("label"); row.className = "cvskrow";
    row.innerHTML = `<input type="checkbox" ${(n.skills || []).includes(s.id) ? "checked" : ""}><span class="nm">${esc(s.name)}</span><span class="au">${esc(s.author || "")}</span>`;
    row.querySelector("input").onchange = (ev) => {
      n.skills = n.skills || [];
      if (ev.target.checked) { if (!n.skills.includes(s.id)) n.skills.push(s.id); }
      else n.skills = n.skills.filter((x) => x !== s.id);
      cvSave(); cvSkillsRow(n, cvEls[n.id]); cvDrawEdges();
    };
    m.appendChild(row);
  }
  const foot = document.createElement("div"); foot.className = "cvskfoot";
  const nb = document.createElement("button"); nb.textContent = "＋ New skill"; nb.onclick = () => { cvHideMenu(); openSkillEditor(); };
  const lb = document.createElement("button"); lb.textContent = "Skills library"; lb.onclick = () => { cvHideMenu(); openSkills(); };
  foot.append(nb, lb); m.appendChild(foot);
}
async function cvSkillBlock(n) {
  const ids = n.skills || []; if (!ids.length) return "";
  const parts = [];
  for (const id of ids) {
    if (!(id in cvSkillCache)) { try { const d = await api("/api/skills?id=" + encodeURIComponent(id)); cvSkillCache[id] = d.skill || null; } catch { cvSkillCache[id] = null; } }
    const s = cvSkillCache[id];
    if (s && s.instructions) parts.push(`[SKILL: ${s.name}]\n${s.instructions}`);
  }
  if (!parts.length) return "";
  return "ACTIVE SKILLS — apply each one ONLY where it is applicable to this request; silently ignore any that are not applicable:\n\n" + parts.join("\n\n---\n\n") + "\n\n===\n\n";
}
function cvAddNodeEl(n) {
  const el = document.createElement("div");
  el.className = "cvnode " + n.kind; el.dataset.id = n.id;
  el.style.left = n.x + "px"; el.style.top = n.y + "px";
  el.style.width = (n.w || { image: 280, video: 300, prompt: 320, text: 340 }[n.kind] || 300) + "px";
  if (n.kind === "image") {
    el.innerHTML = `<div class="cvimgwrap">${n.dataUrl ? `<img src="${n.dataUrl}" draggable="false">` : `<div class="cvmissing">loading…</div>`}</div>
      <button class="cvchat corner" title="send this image — and anything linked to it — to the Dual Mind chat">💬</button>
      <button class="cvx" title="remove from board (the image stays in your gallery)">✕</button>
      <div class="cvport" title="drag off to grow from this image">＋</div>`;
    cvWireMedia(n, el);
  } else if (n.kind === "video") {
    el.innerHTML = `<div class="cvimgwrap">${n.src ? `<video src="${n.src}" muted loop playsinline preload="metadata" draggable="false"></video><div class="vbadge">▶ VIDEO</div>` : `<div class="cvmissing">loading…</div>`}</div>
      ${n.src ? `<button class="cvcont corner" title="Continue clip — starts the next shot from this clip's final frame, so the two cut together seamlessly">⏭ continue</button>` : ""}
      <button class="cvx" title="remove from board (the clip stays in your gallery)">✕</button>
      <div class="cvport" title="drag off to grow from this clip">＋</div>`;
    cvWireMedia(n, el);
  } else if (n.kind === "text") {
    el.innerHTML = `<div class="cvphead">TEXT<span class="sp"></span><button class="cvchat" title="send linked images + notes to the Dual Mind chat">💬</button><select class="cvagent" title="which mind answers"></select><button class="cvx" title="remove">✕</button></div>
      <textarea class="cvtext" placeholder="ask anything — a connected image is seen, connected text is remembered…">${esc(n.text || "")}</textarea>
      <div class="cvrow"><button class="btn-solid cvask">Ask</button><span class="cvstat"></span></div>
      <div class="cvreply ${n.reply ? "" : "hide"}"><div class="who"><span class="agname">${esc(n.replyBy || "REPLY")}</span><button class="copybtn">COPY</button></div><div class="bub">${esc(n.reply || "")}</div></div>
      <div class="cvport" title="drag off to continue the thread or generate from it">＋</div>`;
    const ta = el.querySelector(".cvtext");
    ta.oninput = () => { n.text = ta.value; clearTimeout(el._t); el._t = setTimeout(cvSave, 500); };
    ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); cvAsk(n.id); } };
    const ag = el.querySelector(".cvagent"); cvAgentOptions(ag, n.agent);
    ag.onchange = () => { n.agent = ag.value; cvSave(); };
    el.querySelector(".cvask").onclick = () => cvAsk(n.id);
    el.querySelector(".copybtn").onclick = () => copyText(n.reply || "");
  } else {
    const out = n.out || "image";
    const vprov = n.vprov || "venice";
    const iprov = "openai";   // v60: images are OpenAI-only (Venice/ArtCraft = video credits)
    if (n.iprov && n.iprov !== "openai") { n.iprov = "openai"; cvSave(); }   // heal boards saved before v60
    el.innerHTML = `<div class="cvphead">PROMPT${out === "video" ? `<span class="cvapi ${vprov === "artcraft" ? "ac" : "vn"}" title="the API this node renders on">${vprov.toUpperCase()} API</span><span class="cvbeat hide" title="a music reference is attached — Seedance will time this clip to it">🎵 beat-synced</span>` : `<span class="cvapi oa" title="image generation runs on OpenAI only">OPENAI API</span>`}<span class="sp"></span><select class="cvout" title="what this node generates"><option value="image" ${out === "image" ? "selected" : ""}>🖼 Image</option><option value="video" ${out === "video" ? "selected" : ""}>🎬 Video</option></select><button class="cvx" title="remove">✕</button></div>
      <textarea class="cvtext" placeholder="${out === "video" ? "describe the motion / scene…  e.g. 'slow push-in, she turns and smiles, rain starts'" : "recreate / edit / change…  e.g. 'make it golden hour' or 'same character, side profile'"}">${esc(n.text || "")}</textarea>
      <div class="cvctl">
        ${out === "video" ? `<select class="cvvprov" title="which video API renders this clip — Venice or ArtCraft"></select>` : `<span class="cvfixed" title="image generation runs on OpenAI GPT Image only — Venice and ArtCraft credits are reserved for video">OpenAI · GPT Image</span>`}
        <select class="cvrmodel" title="${out === "video" ? "Seedance workflow — Auto picks the right variant from what you connect (image ⇒ reference/first-frame, none ⇒ text-to-video)" : "image model"}"><option value="">${out === "video" ? "Auto — match my refs" : "gpt-image-2 (default)"}</option></select>
      </div>
      <div class="cvrow">${out === "image"
        ? `<select class="cvcount" title="how many variations">${["1", "2", "3", "4"].map((c) => `<option value="${c}" ${c === (n.count || "1") ? "selected" : ""}>×${c}</option>`).join("")}</select>
           <select class="cvaspect" title="aspect ratio">${["1:1", "16:9", "9:16", "4:3", "3:2"].map((a) => `<option ${a === (n.aspect || "1:1") ? "selected" : ""}>${a}</option>`).join("")}</select>
           <select class="cvquality" title="quality — HIGH can take minutes and will time out; medium is the sweet spot">${["low", "medium", "high"].map((q) => `<option ${q === (n.iq || "medium") ? "selected" : ""}>${q}</option>`).join("")}</select>`
        : `<select class="cvdur" title="duration">${["5s", "10s", "15s"].map((d) => `<option ${d === (n.dur || "5s") ? "selected" : ""}>${d}</option>`).join("")}</select>
           <select class="cvres" title="resolution">${["1080p", "720p", "480p"].map((r) => `<option ${r === (n.res || "720p") ? "selected" : ""}>${r}</option>`).join("")}</select>
           <select class="cvaspect" title="aspect ratio (ignored when a source image/clip sets it)">${["16:9", "9:16", "1:1"].map((a) => `<option ${a === (n.aspect || "16:9") ? "selected" : ""}>${a}</option>`).join("")}</select>`}
        <button class="btn-solid cvgen">Generate</button><span class="cvstat"></span>
      </div>
      ${out === "video" ? `<div class="cvrefs">
        <div class="cvref-sec">
          <div class="cvref-h"><span class="t">🖼 Image refs</span><span class="lim">up to 9</span></div>
          <div class="cvrefzone" data-kind="image">drop images — or <u class="cvrefpick" data-kind="image">browse</u></div>
          <div class="cvrefchips img"></div>
        </div>
        <div class="cvref-sec">
          <div class="cvref-h"><span class="t">🎵 Music</span><span class="lim">wav / mp3</span></div>
          <div class="cvrefzone" data-kind="audio">drop your track — or <u class="cvrefpick" data-kind="audio">browse</u></div>
          <div class="cvslicer hide"></div>
          <div class="cvrefchips aud"></div>
          <div class="cvref-note"></div>
        </div>
      </div>` : ""}`;
    const ta = el.querySelector(".cvtext");
    ta.oninput = () => { n.text = ta.value; clearTimeout(el._t); el._t = setTimeout(cvSave, 500); };
    ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); cvGenerate(n.id); } };
    el.querySelector(".cvout").onchange = (e) => { n.out = e.target.value; n.rmodel = null; cvSave(); cvRebuildNode(n); };
    const pv = el.querySelector(".cvvprov");
    if (pv) {
      const acState = artcraftState === "connected" ? "" : (artcraftState === "blocked" ? " · parked" : " · not connected");
      pv.innerHTML = `<option value="venice">Venice API</option><option value="artcraft">ArtCraft API${acState}</option>`;
      pv.value = vprov;
      pv.onchange = () => { n.vprov = pv.value; n.rmodel = null; cvSave(); cvRebuildNode(n); };
    }
    const qs = el.querySelector(".cvquality");
    if (qs) qs.onchange = () => { n.iq = qs.value; cvSave(); };
    const rm = el.querySelector(".cvrmodel");
    cvRenderModels(out === "video" ? vprov : "gpt", out).then((models) => {
      for (const m of models) { const o = document.createElement("option"); o.value = m.id; o.textContent = m.label || m.id; rm.appendChild(o); }
      if (n.rmodel) rm.value = n.rmodel;
    });
    rm.onchange = () => { n.rmodel = rm.value || null; cvSave(); };
    const cc = el.querySelector(".cvcount"); if (cc) cc.onchange = (e) => { n.count = e.target.value; cvSave(); };
    const cd = el.querySelector(".cvdur"); if (cd) cd.onchange = (e) => { n.dur = e.target.value; cvSave(); };
    const cr = el.querySelector(".cvres"); if (cr) cr.onchange = (e) => { n.res = e.target.value; cvSave(); };
    el.querySelector(".cvaspect").onchange = (e) => { n.aspect = e.target.value; cvSave(); };
    el.querySelector(".cvgen").onclick = () => cvGenerate(n.id);
    if (out === "video") cvWireRefZone(n, el);
  }
  el.querySelector(".cvx").onclick = () => cvRemove(n.id);
  const cvc = el.querySelector(".cvchat"); if (cvc) cvc.onclick = (e) => { e.stopPropagation(); cvSendToChat(n.id); };
  const cvk = el.querySelector(".cvcont"); if (cvk) cvk.onclick = (e) => { e.stopPropagation(); cvContinueClip(n.id); };
  const rz = document.createElement("div"); rz.className = "cvrz"; rz.title = "drag to resize";
  el.appendChild(rz);
  cvSkillsRow(n, el);
  $("cvNodes").appendChild(el); cvEls[n.id] = el;
  return el;
}
/* ---- reference drop-spot on video generator nodes (v54) ----
   The visible "can I attach here?" surface: images (up to 9) and music/audio
   (wav/mp3, 2–15s each, ≤15s combined — Venice's Seedance limits) ride the
   generation as reference_image_urls / reference_audio_urls. */
function cvRefs(n) { if (!n.refs) n.refs = { imgs: [], aud: [] }; n.refs.imgs = n.refs.imgs || []; n.refs.aud = n.refs.aud || []; return n.refs; }

/* ---- music references (v63) --------------------------------------------------
   Venice caps a reference to 15s of audio, so a whole song can't be sent. Rather
   than making the operator trim a snippet in another app, the full track is held
   in memory (never saved to the board) and a window of it is cut here, in the
   browser: decode → downmix to mono → resample to 22.05k → slice → WAV. Small
   enough to send inline, plenty for beat/timing reference. ------------------- */
const cvTracks = {};          // nodeId -> { name, dur, buf(ArrayBuffer) } — deliberately NOT persisted
const MUSIC_WINDOW = 15;      // Venice's hard cap, in seconds
const fmtClock = (t) => { t = Math.max(0, Math.round(t)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };

function wavFromBuffer(ab) {
  const ch = ab.getChannelData(0), sr = ab.sampleRate, n = ch.length;
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, v) => { for (let i = 0; i < v.length; i++) out.setUint8(o + i, v.charCodeAt(i)); };
  str(0, "RIFF"); out.setUint32(4, 36 + n * 2, true); str(8, "WAVE");
  str(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, "data"); out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, ch[i])); out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true); }
  let bin = ""; const u8 = new Uint8Array(out.buffer);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return "data:audio/wav;base64," + btoa(bin);
}
async function decodeTrack(arrayBuffer) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try { return await ctx.decodeAudioData(arrayBuffer.slice(0)); } finally { try { ctx.close(); } catch {} }
}
// Cut [start, start+len) out of the decoded track as a small mono WAV.
async function sliceTrackToWav(decoded, start, len) {
  const SR = 22050;
  const frames = Math.max(1, Math.floor(len * SR));
  const off = new OfflineAudioContext(1, frames, SR);
  const src = off.createBufferSource(); src.buffer = decoded;
  src.connect(off.destination);
  src.start(0, Math.max(0, start), len);
  return wavFromBuffer(await off.startRendering());
}

async function cvAddRefFiles(n, files) {
  const refs = cvRefs(n);
  let added = 0;
  for (const f of [...files]) {
    if (!f || !f.type) continue;
    if (f.type.startsWith("image/")) {
      if (refs.imgs.length >= 9) { toast("max 9 image refs"); continue; }
      try {
        const a = await shrinkAtt(await fileToImg(f));
        const r = { dataUrl: a.dataUrl, galleryId: null };
        refs.imgs.push(r); added++;
        api("/api/gallery", { dataUrl: a.dataUrl, name: "video ref" }).then((d) => { if (d && d.entry && d.entry.id) { r.galleryId = d.entry.id; cvSave(); } }).catch(() => {});
      } catch { toast("couldn't read " + (f.name || "image")); }
    } else if (f.type.startsWith("audio/") || /\.(wav|mp3)$/i.test(f.name || "")) {
      if (!/wav|mpeg|mp3/i.test(f.type) && !/\.(wav|mp3)$/i.test(f.name || "")) { toast((f.name || "audio") + ": Venice takes .wav or .mp3 only"); continue; }
      if (refs.aud.length >= 3) { toast("max 3 music refs on one clip"); continue; }
      if (f.size > 40000000) { toast((f.name || "track") + " is over 40MB — export a smaller file"); continue; }
      try { await cvLoadTrack(n, f); added++; }
      catch { toast("couldn't read " + (f.name || "track")); }
    }
  }
  if (added) { cvSave(); const el = cvEls[n.id]; if (el) cvRenderRefs(n, el); }
  return added;
}

// A dropped song becomes the node's working track; short files attach as-is.
async function cvLoadTrack(n, file) {
  const el = cvEls[n.id];
  const zone = el && el.querySelector('.cvrefzone[data-kind="audio"]');
  if (zone) zone.textContent = "reading " + (file.name || "track") + "…";
  const buf = await file.arrayBuffer();
  const decoded = await decodeTrack(buf);
  const dur = decoded.duration || 0;
  cvTracks[n.id] = { name: (file.name || "track").slice(0, 48), dur, decoded };
  if (dur <= MUSIC_WINDOW + 0.25) {
    // already short enough: attach the whole thing
    const wav = await sliceTrackToWav(decoded, 0, Math.min(dur, MUSIC_WINDOW));
    cvRefs(n).aud.push({ dataUrl: wav, name: cvTracks[n.id].name, dur: Math.round(dur * 10) / 10, from: 0 });
    delete cvTracks[n.id];
  } else {
    n.trackStart = 0;   // long track: the operator picks the window
  }
  cvSave(); if (el) cvRenderRefs(n, el);
}

// The window picker: shown only while a long track is loaded on this node.
function cvRenderSlicer(n, el) {
  const box = el.querySelector(".cvslicer"); if (!box) return;
  const t = cvTracks[n.id];
  if (!t) { box.classList.add("hide"); box.innerHTML = ""; return; }
  const maxStart = Math.max(0, t.dur - MUSIC_WINDOW);
  const start = Math.min(Math.max(0, n.trackStart || 0), maxStart);
  box.classList.remove("hide");
  box.innerHTML = `<div class="sl-h">🎵 ${esc(t.name)} <span class="dim">${fmtClock(t.dur)}</span></div>
    <input class="sl-range" type="range" min="0" max="${Math.floor(maxStart)}" step="1" value="${Math.floor(start)}">
    <div class="sl-row"><span class="sl-win">${fmtClock(start)} → ${fmtClock(start + MUSIC_WINDOW)}</span>
      <button class="sl-play" title="preview this window">▶</button>
      <button class="sl-use btn-solid">✂ use this ${MUSIC_WINDOW}s</button>
      <button class="sl-drop" title="discard this track">✕</button></div>`;
  const range = box.querySelector(".sl-range"), win = box.querySelector(".sl-win");
  range.oninput = () => { n.trackStart = Number(range.value); win.textContent = fmtClock(n.trackStart) + " → " + fmtClock(n.trackStart + MUSIC_WINDOW); };
  box.querySelector(".sl-play").onclick = async (e) => {
    e.stopPropagation();
    try {
      const wav = await sliceTrackToWav(t.decoded, n.trackStart || 0, MUSIC_WINDOW);
      const a = new Audio(wav); a.play().catch(() => toast("preview blocked by the browser"));
    } catch { toast("couldn't preview that window"); }
  };
  box.querySelector(".sl-use").onclick = async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = "cutting…";
    try {
      const wav = await sliceTrackToWav(t.decoded, n.trackStart || 0, MUSIC_WINDOW);
      cvRefs(n).aud.push({ dataUrl: wav, name: t.name + " " + fmtClock(n.trackStart || 0), dur: MUSIC_WINDOW, from: n.trackStart || 0 });
      delete cvTracks[n.id]; cvSave(); cvRenderRefs(n, el);
      toast("music window attached — Seedance will cut to it");
    } catch { toast("couldn't cut that window"); btn.disabled = false; btn.textContent = "✂ use this " + MUSIC_WINDOW + "s"; }
  };
  box.querySelector(".sl-drop").onclick = (e) => { e.stopPropagation(); delete cvTracks[n.id]; cvRenderRefs(n, el); };
}

function cvBindPicks(n, el) {
  el.querySelectorAll(".cvrefpick").forEach((pick) => {
    pick.onclick = (e) => {
      e.stopPropagation();
      const kind = pick.dataset.kind;
      const inp = document.createElement("input"); inp.type = "file"; inp.multiple = kind === "image";
      inp.accept = kind === "image" ? "image/*" : "audio/wav,audio/mpeg,.wav,.mp3";
      inp.onchange = () => cvAddRefFiles(n, inp.files);
      inp.click();
    };
  });
}
function cvRenderRefs(n, el) {
  const refs = cvRefs(n);
  // restore the drop label (cvLoadTrack borrows it for "reading …" progress)
  const az = el.querySelector('.cvrefzone[data-kind="audio"]');
  if (az && !cvTracks[n.id]) az.innerHTML = 'drop your track — or <u class="cvrefpick" data-kind="audio">browse</u>';
  const imgBox = el.querySelector(".cvrefchips.img"), audBox = el.querySelector(".cvrefchips.aud");
  if (imgBox) {
    imgBox.innerHTML = "";
    refs.imgs.forEach((r, i) => {
      const c = document.createElement("span"); c.className = "cvrefchip img";
      c.innerHTML = (r.dataUrl ? `<img src="${r.dataUrl}">` : "🖼") + `<button class="x" title="remove">✕</button>`;
      c.title = "image reference " + (i + 1);
      c.querySelector(".x").onclick = (e) => { e.stopPropagation(); refs.imgs.splice(i, 1); cvSave(); cvRenderRefs(n, el); };
      imgBox.appendChild(c);
    });
  }
  if (audBox) {
    audBox.innerHTML = "";
    refs.aud.forEach((r, i) => {
      const lost = !r.dataUrl;
      const c = document.createElement("span"); c.className = "cvrefchip aud" + (lost ? " lost" : "");
      c.innerHTML = `🎵 <span class="nm">${esc(r.name || "track")}</span><span class="dur">${r.dur ? r.dur + "s" : ""}</span>${lost ? "<span class='dim'>— re-drop</span>" : ""}`;
      c.title = lost ? "music doesn't survive a reload — drop the track again" : "music reference — steers Seedance's timing, beat and cuts";
      if (!lost) {
        const play = document.createElement("button"); play.className = "x"; play.textContent = "▶"; play.title = "preview";
        play.onclick = (e) => { e.stopPropagation(); const a = new Audio(r.dataUrl); a.play().catch(() => {}); };
        c.appendChild(play);
      }
      const x = document.createElement("button"); x.className = "x"; x.textContent = "✕"; x.title = "remove";
      x.onclick = (e) => { e.stopPropagation(); refs.aud.splice(i, 1); cvSave(); cvRenderRefs(n, el); };
      c.appendChild(x); audBox.appendChild(c);
    });
  }
  cvRenderSlicer(n, el);
  cvBindPicks(n, el);

  // say what will actually happen, right where the decision is made
  const note = el.querySelector(".cvref-note");
  const beat = el.querySelector(".cvbeat");
  const hasAud = refs.aud.length > 0;
  if (beat) beat.classList.toggle("hide", !hasAud);
  if (note) {
    let msg = "", cls = "cvref-note";
    if (hasAud && !refs.imgs.length && !cvNode(n.parentId)) { msg = "⚠ music can't go alone — connect an image or drop one above"; cls += " warn"; }
    else if (hasAud && n.contFrom) { msg = "⚠ music switches this to reference-mode, so it won't start exactly on the previous frame. Remove it to keep the seam."; cls += " warn"; }
    else if (hasAud) { msg = "Seedance will time this clip to your track"; cls += " ok"; }
    note.className = cls; note.textContent = msg;
  }
}

function cvWireRefZone(n, el) {
  const zones = [...el.querySelectorAll(".cvrefzone")];
  if (!zones.length) return;
  cvRenderRefs(n, el);
  ["dragenter", "dragover"].forEach((ev) => el.addEventListener(ev, (e) => {
    if ([...(e.dataTransfer ? e.dataTransfer.types : [])].some((t) => t === "Files" || t === "application/x-plx-media")) {
      e.preventDefault(); e.stopPropagation();
      const z = e.target.closest && e.target.closest(".cvrefzone");
      zones.forEach((q) => q.classList.toggle("over", !z || q === z));
    }
  }));
  el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget)) zones.forEach((q) => q.classList.remove("over")); });
  el.addEventListener("drop", async (e) => {
    e.preventDefault(); e.stopPropagation(); zones.forEach((q) => q.classList.remove("over"));
    const plx = e.dataTransfer.getData("application/x-plx-media");
    if (plx) {
      try {
        const item = JSON.parse(plx);
        if (item.type === "video") { toast("clips connect as a source — drag the board node's ＋ handle instead"); return; }
        const att = await srcToImgAtt(item.src);
        if (att) { const refs = cvRefs(n); if (refs.imgs.length >= 9) { toast("max 9 image refs"); return; } refs.imgs.push({ dataUrl: att.dataUrl, galleryId: item.id || null }); cvSave(); cvRenderRefs(n, el); toast("image ref added"); return; }
      } catch {}
    }
    const got = await cvAddRefFiles(n, (e.dataTransfer && e.dataTransfer.files) || []);
    if (!got) toast("drop an image, or a .wav / .mp3 track");
  });
}
/* ---- Continue clip: build ONE long video out of short generations ----
   Seedance can start a shot from a supplied first frame. So the final frame of clip A
   becomes the first frame of clip B and the two cut together with no visible seam.
   This lays that out on the board — clip → final frame → next prompt — so the chain is
   visible and every link stays re-editable. No file is ever cut. */
async function cvContinueClip(nid) {
  const n = cvNode(nid); if (!n || !n.src) return;
  const btn = cvEls[nid] && cvEls[nid].querySelector(".cvcont");
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    const frame = await grabVideoFrame(n.src, 0.995);   // as close to the final frame as we can seek
    if (!frame) { toast("couldn't read that clip's last frame — a remote URL can block frame capture. Try a clip generated here."); return; }
    await cvWhenReady(); cvLoad();
    const madeBy = cvNode(n.parentId);   // the prompt node that rendered this clip: inherit its settings

    // 1. the final frame, as its own node (visible, reusable, saved to the gallery)
    const img = await cvAddImage(frame.dataUrl, null, n.x + (n.w || 300) + 90, n.y - 20);
    img.parentId = n.id; img.skills = (n.skills || []).slice();
    cv.edges.push({ from: n.id, to: img.id });

    // 2. the next shot, pre-wired to first-frame continuation
    // (ArtCraft has no first-frame upload path yet, so continuation runs on Venice)
    const wasAC = madeBy && madeBy.vprov === "artcraft";
    const next = {
      id: cvId(), kind: "prompt", out: "video", w: 320,
      x: img.x + 320 + 90, y: img.y - 20, parentId: img.id, text: "",
      skills: (n.skills || []).slice(),
      vprov: "venice", rmodel: "seedance-2-0-image-to-video",
      dur: (madeBy && madeBy.dur) || "5s",
      res: (madeBy && madeBy.res) || "720p",
      aspect: (madeBy && madeBy.aspect) || "16:9",
      contFrom: n.id,
    };
    cv.nodes.push(next); cv.edges.push({ from: img.id, to: next.id });
    cvSave();
    const el = cvAddNodeEl(next); el.style.zIndex = ++cvZ; cvDrawEdges(); cvEmptyUpd();
    const ta = el.querySelector(".cvtext");
    if (ta) { ta.placeholder = "what happens NEXT — the shot already starts on the last frame, so describe the continuing action…"; ta.focus(); }
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    toast(wasAC ? "continuing on Venice — first-frame continuation isn't available on ArtCraft yet" : "final frame captured — describe what happens next");
  } catch (e) {
    toast("couldn't continue that clip: " + String(e.message || e).slice(0, 120));
  } finally { if (btn) { btn.disabled = false; btn.textContent = "⏭ continue"; } }
}

/* ---- board → Dual Mind chat: brainstorm on the Neural Board, then prompt off a
   linked cluster. Walks the (undirected) connected component from a node, pulls its
   images in as chat attachments and its text notes in as the prompt seed. ---- */
function cvComponent(startId) {
  const seen = new Set(), q = [startId], out = [];
  while (q.length) {
    const id = q.shift(); if (seen.has(id)) continue; seen.add(id);
    const nn = cvNode(id); if (!nn) continue; out.push(nn);
    for (const e of cv.edges) { if (e.from === id && !seen.has(e.to)) q.push(e.to); if (e.to === id && !seen.has(e.from)) q.push(e.from); }
  }
  return out;
}
async function cvSendToChat(nid) {
  const n = cvNode(nid); if (!n) return;
  const comp = cvComponent(nid);
  const imgs = comp.filter((x) => x.kind === "image" && x.dataUrl);
  const notes = comp.filter((x) => x.kind === "text" && (x.text || "").trim()).map((x) => x.text.trim());
  if (!imgs.length && !notes.length) { toast("nothing linked to send — connect an image or add a note"); return; }
  setScreen("chat");
  let k = 0;
  for (const im of imgs) { const att = await shrinkAtt(dataUrlToAtt(im.dataUrl)); if (att) { chatAtts.push(att); k++; } }
  renderChatAtts();
  const ta = $("chatText");
  if (ta) {
    const seed = notes.length ? notes.join("\n\n") : (k > 1 ? `Using these ${k} linked images, ` : "Using this image, ");
    if (!ta.value.trim()) ta.value = seed;
    ta.focus();
  }
  toast(`${k} image${k !== 1 ? "s" : ""}${notes.length ? ` + ${notes.length} note${notes.length > 1 ? "s" : ""}` : ""} → Dual Mind chat`);
}
function cvWireMedia(n, el) {
  const img = el.querySelector("img");
  if (img) { img.onload = cvDrawEdges; img.onclick = () => { if (!cvJustDragged && n.dataUrl) openLightbox("image", n.dataUrl, { id: n.galleryId }); }; }
  const vid = el.querySelector("video");
  if (vid) {
    vid.onloadedmetadata = () => { n.duration = isFinite(vid.duration) && vid.duration > 0 ? Math.round(vid.duration) : (n.duration || 0); cvDrawEdges(); };
    el.onmouseenter = () => { vid.play().catch(() => {}); };
    el.onmouseleave = () => { vid.pause(); };
    vid.onclick = () => { if (!cvJustDragged && n.src) openLightbox("video", n.src, { id: n.galleryId }); };
  }
}
function cvRebuildNode(n) {
  const old = cvEls[n.id]; const z = old ? old.style.zIndex : "";
  if (old) old.remove(); delete cvEls[n.id];
  const el = cvAddNodeEl(n); if (z) el.style.zIndex = z;
  cvDrawEdges();
}
function cvRemove(id) {
  cv.nodes = cv.nodes.filter((x) => x.id !== id);
  cv.edges = cv.edges.filter((e) => e.from !== id && e.to !== id);
  const el = cvEls[id]; if (el) el.remove(); delete cvEls[id];
  cvSave(); cvDrawEdges(); cvEmptyUpd();
}

/* ---- edges ---- */
function cvAnchor(n, side) {
  const el = cvEls[n.id]; const w = el ? el.offsetWidth : (n.w || 280), h = el ? el.offsetHeight : 120;
  return side === "r" ? { x: n.x + w, y: n.y + h / 2 } : { x: n.x, y: n.y + h / 2 };
}
function cvEdgePath(a, b) { const dx = Math.max(40, Math.abs(b.x - a.x) / 2); return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`; }
function cvDrawEdges(tmp) {
  const svg = $("cvEdges"); if (!svg) return;
  let html = "";
  for (const e of cv.edges) {
    const f = cvNode(e.from), t = cvNode(e.to);
    if (!f || !t) continue;
    html += `<path d="${cvEdgePath(cvAnchor(f, "r"), cvAnchor(t, "l"))}" class="cvedge"/>`;
  }
  if (tmp && tmp.a) html += `<path d="${cvEdgePath(tmp.a, tmp.b)}" class="cvedge tmp"/>`;
  svg.innerHTML = html;
}

/* ---- the drag-off menu: pick what grows from a node ---- */
function cvHideMenu() { if (cvMenuEl) { cvMenuEl.remove(); cvMenuEl = null; } }
function cvShowMenu(e, parent) {
  cvHideMenu();
  const view = cvView(), r = view.getBoundingClientRect();
  const wp = cvWorldPt(e);
  const m = document.createElement("div"); m.className = "cvmenu"; cvMenuEl = m;
  const add = (icon, label, sub, fn) => { const b = document.createElement("button"); b.innerHTML = `<span class="ic">${icon}</span><span class="lb">${label}<small>${sub}</small></span>`; b.onclick = fn; m.appendChild(b); };
  add("🖼", "Image generator", "render a new image from this", () => { cvHideMenu(); cvSpawnChild(parent, "prompt", wp, { out: "image" }); });
  add("🎬", "Video generator", "animate / render a clip from this", () => { cvHideMenu(); cvSpawnChild(parent, "prompt", wp, { out: "video" }); });
  add("💬", "Text", "ask about it · keep the thread going", () => { cvHideMenu(); cvSpawnChild(parent, "text", wp, {}); });
  m.style.left = Math.min(e.clientX - r.left, r.width - 230) + "px";
  m.style.top = Math.min(e.clientY - r.top, r.height - 150) + "px";
  view.appendChild(m);
}
function cvSpawnChild(parent, kind, wp, extra) {
  const n = { id: cvId(), kind, x: wp.x, y: wp.y - 50, parentId: parent ? parent.id : null, text: "", skills: parent && parent.skills ? parent.skills.slice() : [], ...extra };
  if (kind === "prompt") { n.w = 320; n.aspect = extra.out === "video" ? "16:9" : "1:1"; }
  if (kind === "text") n.w = 340;
  cv.nodes.push(n); if (parent) cv.edges.push({ from: parent.id, to: n.id });
  cvSave();
  const el = cvAddNodeEl(n); el.style.zIndex = ++cvZ; cvDrawEdges(); cvEmptyUpd();
  const ta = el.querySelector(".cvtext"); if (ta) ta.focus();
}

/* ---- pan / zoom / node-drag / handle-link ---- */
function cvPointerDown(e) {
  cvLoad();
  if (cvMenuEl && !e.target.closest(".cvmenu")) cvHideMenu();
  if (e.target.closest(".cvmenu")) return;
  const nodeEl = e.target.closest(".cvnode");
  if (e.target.classList.contains("cvrz") && nodeEl) {
    const n = cvNode(nodeEl.dataset.id); if (!n) return;
    nodeEl.style.zIndex = ++cvZ;
    cvDrag = { rz: n, moved: false };
    e.preventDefault(); return;
  }
  if (e.target.classList.contains("cvport") && nodeEl) {
    const n = cvNode(nodeEl.dataset.id);
    if (n) { cvLink = { from: n }; e.preventDefault(); }
    return;
  }
  if (nodeEl && !e.target.closest("textarea,select,button,input,video")) {
    const n = cvNode(nodeEl.dataset.id); if (!n) return;
    nodeEl.style.zIndex = ++cvZ;
    const p = cvWorldPt(e);
    cvDrag = { n, dx: p.x - n.x, dy: p.y - n.y, moved: false };
    e.preventDefault(); return;
  }
  if (!nodeEl) { cvDrag = { pan: true, sx: e.clientX, sy: e.clientY, px: cv.pan.x, py: cv.pan.y }; cvView().classList.add("panning"); }
}
function cvPointerMove(e) {
  if (cvLink) { cvDrawEdges({ a: cvAnchor(cvLink.from, "r"), b: cvWorldPt(e) }); return; }
  if (!cvDrag) return;
  if (cvDrag.rz) {
    const p = cvWorldPt(e);
    const minW = (cvDrag.rz.kind === "image" || cvDrag.rz.kind === "video") ? 180 : 300;
    cvDrag.rz.w = Math.round(Math.max(minW, Math.min(820, p.x - cvDrag.rz.x)));
    const el = cvEls[cvDrag.rz.id]; if (el) el.style.width = cvDrag.rz.w + "px";
    cvDrag.moved = true; cvDrawEdges(); return;
  }
  if (cvDrag.pan) { cv.pan.x = cvDrag.px + (e.clientX - cvDrag.sx); cv.pan.y = cvDrag.py + (e.clientY - cvDrag.sy); cvApply(); return; }
  const p = cvWorldPt(e);
  cvDrag.n.x = p.x - cvDrag.dx; cvDrag.n.y = p.y - cvDrag.dy; cvDrag.moved = true;
  const el = cvEls[cvDrag.n.id]; if (el) { el.style.left = cvDrag.n.x + "px"; el.style.top = cvDrag.n.y + "px"; }
  cvDrawEdges();
}
function cvPointerUp(e) {
  if (cvLink) { const from = cvLink.from; cvLink = null; cvDrawEdges(); cvShowMenu(e, from); return; }
  if (cvDrag && !cvDrag.pan && cvDrag.moved) { cvSave(); cvJustDragged = true; setTimeout(() => { cvJustDragged = false; }, 0); }
  if (cvDrag && cvDrag.pan) { cvView().classList.remove("panning"); cvSave(); }
  cvDrag = null;
}
function cvWheel(e) {
  e.preventDefault(); cvLoad();
  const r = cvView().getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const old = cv.zoom, z = Math.min(2.5, Math.max(0.2, old * (e.deltaY < 0 ? 1.1 : 0.9)));
  cv.pan.x = mx - ((mx - cv.pan.x) / old) * z;
  cv.pan.y = my - ((my - cv.pan.y) / old) * z;
  cv.zoom = z; cvApply();
  clearTimeout(cvWheel._t); cvWheel._t = setTimeout(cvSave, 400);
}

/* ---- adding media to the board ---- */
function cvCenter() { const r = cvView().getBoundingClientRect(); return { x: (r.width / 2 - cv.pan.x) / cv.zoom - 140, y: (r.height / 2 - cv.pan.y) / cv.zoom - 100 }; }
async function cvAddImage(dataUrl, galleryId, x, y) {
  await cvWhenReady(); cvLoad();
  const n = { id: cvId(), kind: "image", x, y, w: 280, galleryId: galleryId || null, dataUrl };
  cv.nodes.push(n); cvSave(); cvAddNodeEl(n); cvDrawEdges(); cvEmptyUpd();
  if (!galleryId && dataUrl) {
    api("/api/gallery", { dataUrl, name: "canvas image" }).then((d) => { if (d && d.entry && d.entry.id) { n.galleryId = d.entry.id; cvSave(); loadRefWallIfOpen(); } }).catch(() => {});
  }
  return n;
}
function cvAddVideo(src, galleryId, x, y, parentId) {
  const par = parentId ? cvNode(parentId) : null;
  const n = { id: cvId(), kind: "video", x, y, w: 300, galleryId: galleryId || null, src, parentId: parentId || null, skills: par && par.skills ? par.skills.slice() : [] };
  cv.nodes.push(n); if (parentId) cv.edges.push({ from: parentId, to: n.id });
  cvSave(); cvAddNodeEl(n); cvDrawEdges(); cvEmptyUpd();
  return n;
}
async function cvAddText(at) {
  await cvWhenReady(); cvLoad();
  const p = at || cvCenter();
  const n = { id: cvId(), kind: "text", x: p.x, y: p.y, w: 340, text: "" };
  cv.nodes.push(n); cvSave();
  const el = cvAddNodeEl(n); el.style.zIndex = ++cvZ; cvEmptyUpd();
  const ta = el.querySelector(".cvtext"); if (ta) ta.focus();
  return n;
}
async function cvAddFiles(files, at) {
  let i = 0;
  for (const f of [...files]) {
    if (!f || !f.type || !f.type.startsWith("image/")) continue;
    if (f.size > 6000000) { toast((f.name || "image") + ": too large (max ~6MB)"); continue; }
    try { const a = await fileToImg(f); const p = at || cvCenter(); await cvAddImage(a.dataUrl, null, p.x + i * 40, p.y + i * 40); i++; } catch { toast("couldn't read image"); }
  }
  if (i) toast(i + " image" + (i > 1 ? "s" : "") + " on the board");
}

/* ---- source resolution: what feeds a generation / a question ----
   Walk up the chain: nearest image becomes the visual source; a video (when no image
   is nearer) becomes a reference; text ancestors become conversation memory. */
async function cvSourceFor(n) {
  let att = null, videoNode = null; const convo = [];
  let cur = cvNode(n.parentId), hops = 0;
  while (cur && hops < 12) {
    if (cur.kind === "image" && !att && cur.dataUrl) att = await shrinkAtt(dataUrlToAtt(cur.dataUrl));
    else if (cur.kind === "video" && !videoNode && !att) videoNode = cur;
    else if (cur.kind === "text" && (cur.text || cur.reply)) convo.unshift({ q: cur.text || "", a: cur.reply || "" });
    cur = cvNode(cur.parentId); hops++;
  }
  return { att, videoNode, convo };
}

/* ---- shared SSE call ---- */
async function cvStream(provider, model, messages, onDelta) {
  const payload = { provider, model, messages };
  const pid = cvBoardProjectId(); if (pid) payload.projectId = pid;
  const res = await fetch("/api/chat", { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) });
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "", text = "", err = null;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      const t = line.trim(); if (!t.startsWith("data:")) continue; const data = t.slice(5).trim(); if (data === "[DONE]") continue;
      let evt; try { evt = JSON.parse(data); } catch { continue; }
      if (evt.delta) { text += evt.delta; if (onDelta) onDelta(text); }
      else if (evt.usage) addSpend(model, evt.usage.input || 0, evt.usage.output || 0);
      else if (evt.error) err = evt.error;
    }
  }
  if (err) throw new Error(err);
  return text.trim();
}
function cvCost(newBal) {
  if (veniceUsd != null && newBal != null) {
    const d = veniceUsd - Number(newBal);
    if (d > 0) { lastGenCost = d; toast(`gen cost ~$${d.toFixed(d < 0.1 ? 4 : 2)} · $${Number(newBal).toFixed(2)} left`); }
  }
  setCredits(newBal);
}

/* ---- text nodes: chat on the board ---- */
async function cvAsk(nid) {
  const n = cvNode(nid); if (!n || n.busy) return;
  const el = cvEls[nid], stat = el && el.querySelector(".cvstat"), btn = el && el.querySelector(".cvask");
  const q = (n.text || "").trim();
  if (!q) { toast("type a question first"); return; }
  n.busy = true; if (btn) btn.disabled = true;
  try {
    if (stat) stat.textContent = "gathering context…";
    const src = await cvSourceFor(n);
    const messages = [];
    for (const c of src.convo) { if (c.q) messages.push({ role: "user", content: c.q }); if (c.a) messages.push({ role: "assistant", content: c.a }); }
    let atts = [];
    if (src.att) atts = [src.att];
    else if (src.videoNode && src.videoNode.src) {
      if (stat) stat.textContent = "sampling frames…";
      atts = await extractFrames(src.videoNode.src, 4);
      if (!atts.length) toast("couldn't sample the clip (remote URL may block it) — answering from text only");
    }
    const skills = await cvSkillBlock(n);
    const qq = skills + (atts.length > 1 ? `The ${atts.length} images above are sampled frames from a video clip. ${q}` : q);
    const content = atts.length
      ? [...atts.map((a) => ({ type: "image", source: { type: "base64", media_type: a.media_type, data: a.data } })), { type: "text", text: qq }]
      : qq;
    messages.push({ role: "user", content });
    const [prov, model] = (n.agent || ("claude|" + $("mClaude").value)).split("|");
    const who = prov === "gpt" ? "CHATGPT" : "CLAUDE";
    const reply = el.querySelector(".cvreply"), bub = reply.querySelector(".bub"), nameEl = reply.querySelector(".agname");
    reply.classList.remove("hide"); reply.classList.toggle("gptside", prov === "gpt"); nameEl.textContent = who; bub.textContent = "";
    if (stat) stat.textContent = "thinking…";
    const text = await cvStream(prov, model, messages, (t) => { bub.textContent = t; });
    if (!text) throw new Error("no reply returned");
    n.reply = text; n.replyBy = who; cvSave(); cvDrawEdges();
    if (stat) stat.textContent = "";
  } catch (e) {
    const msg = String(e.message || e);
    if (stat) { stat.textContent = "⚠ " + msg; stat.title = msg; }
    toast("⚠ " + (msg.length > 160 ? msg.slice(0, 160) + "…" : msg));
  }
  finally { n.busy = false; if (btn) btn.disabled = false; }
}

/* ---- prompt nodes: generate image or video ---- */
async function cvWritePromptFor(n, src, prov, pmodel) {
  const isVideo = (n.out || "image") === "video";
  const instruction = (n.text || "").trim();
  let context = "";
  if (src.convo.length) context = "Context from the conversation this grew out of:\n" + src.convo.map((c) => `Q: ${c.q}\nA: ${c.a}`).join("\n") + "\n\n";
  const task = isVideo
    ? `Write ONE detailed video-generation prompt for Seedance (subject, motion, camera moves, timing, mood, style). `
    : `Write ONE detailed image-generation prompt (subject, composition, style, lighting, palette, quality tags). `;
  const faithful = src.att || src.videoNode ? "Stay faithful to the source's subject, composition and style except where the request changes them. " : "";
  // A continuation must read as the SAME take rolling on, not a new setup.
  const cont = n.contFrom ? "This shot is a DIRECT CONTINUATION: the attached image is the final frame of the previous clip and will be this clip's first frame. Keep the same character, wardrobe, lighting, lens, grade and location so the two cut together invisibly. Describe only the action that follows — do not re-establish the scene, do not cut to a new angle. " : "";
  const skills = await cvSkillBlock(n);
  const wrap = `${skills}${context}${src.att ? "Look at the attached source image. " : ""}Request: ${instruction || "(no extra request — continue the shot naturally)"}\n\n${task}${cont}${faithful}Output ONLY the prompt text.`;
  const content = src.att
    ? [{ type: "image", source: { type: "base64", media_type: src.att.media_type, data: src.att.data } }, { type: "text", text: wrap }]
    : wrap;
  return cvStream(prov, pmodel, [{ role: "user", content }]);
}
async function cvGenerate(nid) {
  const n = cvNode(nid); if (!n || n.busy) return;
  const el = cvEls[nid], stat = el && el.querySelector(".cvstat"), btn = el && el.querySelector(".cvgen");
  const text = (n.text || "").trim();
  const out = n.out || "image";
  n.busy = true; if (btn) btn.disabled = true;
  try {
    if (stat) stat.textContent = "reading source…";
    const src = await cvSourceFor(n);
    const nrefs = n.refs || {};
    const refImgs = (nrefs.imgs || []).filter((r) => r.dataUrl);
    const refAud = (nrefs.aud || []).filter((r) => r.dataUrl);
    if (!text && !src.att && !src.videoNode && !refImgs.length) throw new Error("describe what to generate, connect this to an image/clip, or drop a ref in the spot");
    // Prompt-writing happens behind the scenes on the top-bar Claude model — the box
    // itself only exposes generation choices (per Pixel: LLM picks live on Text nodes).
    if (stat) stat.textContent = "writing prompt…";
    const prompt = await cvWritePromptFor(n, src, "claude", $("mClaude").value);
    if (!prompt) throw new Error("prompt writing returned nothing");
    if (out === "image") {
      // Variants fan out as PARALLEL single-image renders: N never takes longer than 1,
      // one slow/failed render can't kill the batch, and each request stays well inside
      // the serverless window (the old single ×N request was what hit platform 502s).
      const count = Math.max(1, Math.min(4, Number(n.count || "1") || 1));
      if (stat) stat.textContent = count > 1 ? `rendering ${count} in parallel…` : "rendering…";
      // v60: images always render on OpenAI — Venice/ArtCraft credits are video-only.
      const reqBase = { brief: text || "recreate the source image", prewritten: prompt, projectId: cvBoardProjectId() || undefined, options: { provider: "openai", model: n.rmodel || undefined, aspect_ratio: n.aspect || "1:1", variants: "1", quality: n.iq || "medium" } };
      const results = await Promise.allSettled(Array.from({ length: count }, () => api("/api/image", { ...reqBase, options: { ...reqBase.options } })));
      let ok = 0, lastErr = null, bal = null;
      results.forEach((res, i) => {
        const v = res.status === "fulfilled" ? res.value : null;
        if (v && !v.error && v.stage === "generated" && v.images && v.images.length) {
          if (v.balanceUsd != null) bal = v.balanceUsd;
          const im = v.images[0];
          const child = { id: cvId(), kind: "image", x: n.x + (n.w || 320) + 90, y: n.y - 40 + i * 250, w: 280, galleryId: im.id || null, dataUrl: im.dataUrl, parentId: n.id, skills: (n.skills || []).slice() };
          cv.nodes.push(child); cv.edges.push({ from: n.id, to: child.id });
          cvAddNodeEl(child); ok++;
        } else {
          lastErr = res.status === "rejected" ? res.reason : new Error((v && (v.error || v.note)) || "no image returned");
        }
      });
      if (bal != null) cvCost(bal);
      // GPT-image renders have no live balance header — count a close per-quality
      // estimate into the meters so Space usage is never invisible money.
      if (ok) {
        const OPENAI_IMG_EST = { low: 0.011, medium: 0.042, high: 0.167 };
        addFlatSpend("openai", (OPENAI_IMG_EST[n.iq || "medium"] || 0.042) * ok);
      }
      cvSave(); cvDrawEdges(); loadRefWallIfOpen();
      if (!ok) throw lastErr || new Error("no image returned");
      if (stat) {
        stat.textContent = ok === count ? "done ✓" : `done ${ok}/${count} — one failed: ${String((lastErr && lastErr.message) || "")}`.slice(0, 140);
        if (ok !== count && lastErr) stat.title = String(lastErr.message || lastErr);
      }
    } else {
      // aspect always rides along: video.js drops it for first-frame i2v (Venice rejects it
      // there) but reference-to-video and text-to-video REQUIRE it (Venice 400s without it).
      const req = { brief: text || "animate the source", prewritten: prompt, projectId: cvBoardProjectId() || undefined, options: { provider: n.vprov || "venice", model: n.rmodel || undefined, duration: n.dur || "5s", resolution: n.res || "720p", aspect_ratio: n.aspect || "16:9" } };
      // Source image (from the parent chain) + dropped image refs all ride along;
      // the backend routes to Seedance reference→video when more than one is present.
      const imgAtts = [];
      if (src.att) imgAtts.push(src.att);
      for (const r of refImgs) { const a = dataUrlToAtt(r.dataUrl); if (a) imgAtts.push(await shrinkAtt(a)); }
      if (imgAtts.length) req.images = imgAtts.slice(0, 9).map((a) => ({ media_type: a.media_type, data: a.data }));
      if (src.videoNode && src.videoNode.src && !/^data:/.test(src.videoNode.src)) req.videos = [{ url: src.videoNode.src, duration: src.videoNode.duration || 0 }];
      if (refAud.length) {
        if ((n.vprov || "venice") !== "venice") throw new Error("audio references render on Venice (Seedance reference→video) — switch this node's API to Venice");
        if (!imgAtts.length && !req.videos) throw new Error("Venice needs an image or clip alongside audio — connect one to this node or drop an image in the ref spot");
        req.audio = refAud.slice(0, 3).map((r) => ({ url: r.dataUrl, duration: r.dur || 0 }));
      }
      await cvVideoSubmit(n, req);
    }
  } catch (e) {
    // The status line truncates — put the full reason in its tooltip AND a toast.
    const msg = String(e.message || e);
    if (stat) { stat.textContent = "⚠ " + msg; stat.title = msg; }
    toast("⚠ " + (msg.length > 160 ? msg.slice(0, 160) + "…" : msg));
  }
  finally { n.busy = false; if (btn) btn.disabled = false; }
}
async function cvVideoSubmit(n, req) {
  const el = cvEls[n.id], stat = el && el.querySelector(".cvstat");
  const apiName = (req.options.provider || "venice") === "artcraft" ? "ArtCraft" : "Venice";
  if (stat) stat.textContent = `queueing on ${apiName}…`;
  const r = await api("/api/video", req);
  if (r.error) throw new Error(r.error);
  if (r.stage === "consent") { cvConsent(n, req, r); return; }
  if (r.stage !== "queued") throw new Error(r.note || "couldn't queue the render");
  if (r.note) toast(r.note);
  if (r.balanceUsd != null) cvCost(r.balanceUsd);
  await cvPollVideo(n, r.job, r.model || "", r.provider || req.options.provider || "venice");
}
// Venice face-media consent, inline on the node — never auto-accepted.
function cvConsent(n, req, r) {
  const el = cvEls[n.id]; if (!el) return;
  const old = el.querySelector(".cvconsent"); if (old) old.remove();
  const box = document.createElement("div"); box.className = "cvconsent";
  box.innerHTML = `<div class="ch">⚠ FACE-MEDIA CONSENT${r.faceRoles && r.faceRoles.length ? " (" + esc(r.faceRoles.join(", ")) + ")" : ""}</div>
    <div class="cp">${esc(r.policyText || "")}</div>
    <label><input type="checkbox" class="cchk"><span>I attest — the likeness is mine or I have explicit legal consent from every depicted person.</span></label>
    <button class="btn-solid cgo" disabled style="opacity:.5">Confirm & render</button>`;
  el.appendChild(box);
  const chk = box.querySelector(".cchk"), go = box.querySelector(".cgo");
  chk.onchange = () => { go.disabled = !chk.checked; go.style.opacity = chk.checked ? "1" : ".5"; };
  go.onclick = async () => {
    box.remove();
    const stat = el.querySelector(".cvstat"), btn = el.querySelector(".cvgen");
    n.busy = true; if (btn) btn.disabled = true;
    try { await cvVideoSubmit(n, { ...req, consent: true }); }
    catch (e) { if (stat) stat.textContent = "⚠ " + String(e.message || e); }
    finally { n.busy = false; if (btn) btn.disabled = false; }
  };
  cvDrawEdges();
}
async function cvPollVideo(n, job, model, provider) {
  const el = cvEls[n.id], stat = el && el.querySelector(".cvstat");
  const apiName = provider === "artcraft" ? "ArtCraft" : "Venice";
  if (!job) throw new Error("no job token returned");
  for (let i = 0; i < 72; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    let d;
    try {
      d = provider === "artcraft"
        ? await api(`/api/genjob?provider=artcraft&job=${encodeURIComponent(job)}&type=video`)
        : await api(`/api/video?job=${encodeURIComponent(job)}&model=${encodeURIComponent(model)}`);
    } catch { continue; }
    if (d.url) {
      cvAddVideo(d.url, d.mediaId || null, n.x + (n.w || 320) + 90, n.y - 30, n.id);
      loadRefWallIfOpen();
      if (stat) stat.textContent = `done ✓ · ${apiName}`;
      return;
    }
    if (d.failed || d.error || /fail|error|dead|cancel/i.test(d.status || "")) throw new Error(apiName + " render failed: " + (d.status || d.error || ""));
    if (stat) stat.textContent = `rendering on ${apiName}… ${d.status || "processing"} (${Math.round(((i + 1) * 5) / 60)}m)`;
  }
  if (stat) stat.textContent = "still rendering — the clip will land in your gallery; drag it on when it's done";
}

/* ---- boards: list / open / switch / migrate ---- */
function cvRebuildAll() {
  $("cvNodes").innerHTML = ""; for (const k in cvEls) delete cvEls[k];
  for (const n of cv.nodes) cvAddNodeEl(n);
  cvApply(); cvDrawEdges(); cvEmptyUpd();
  cvHydrateRefs();
  for (const n of cv.nodes) {
    const needsImg = n.kind === "image" && !n.dataUrl && n.galleryId;
    const needsVid = n.kind === "video" && !n.src && n.galleryId;
    if (!needsImg && !needsVid) continue;
    api("/api/gallery?id=" + encodeURIComponent(n.galleryId))
      .then((it) => {
        if (n.kind === "image") n.dataUrl = it.dataUrl || it.url || "";
        else n.src = it.url || it.dataUrl || "";
        cvRebuildNode(n);
      })
      .catch(() => { const el = cvEls[n.id]; if (el) { const w = el.querySelector(".cvimgwrap"); if (w) w.innerHTML = '<div class="cvmissing">missing — deleted from gallery?</div>'; } });
  }
}
function cvHydrateRefs() {
  for (const n of cv.nodes) {
    const imgs = (n.refs && n.refs.imgs) || [];
    if (n.kind !== "prompt" || !imgs.some((r) => !r.dataUrl && r.galleryId)) continue;
    Promise.all(imgs.map((r) => (!r.dataUrl && r.galleryId)
      ? api("/api/gallery?id=" + encodeURIComponent(r.galleryId)).then((it) => { r.dataUrl = it.dataUrl || it.url || ""; }).catch(() => {})
      : null)).then(() => { const el = cvEls[n.id]; if (el) cvRenderRefs(n, el); });
  }
}
function cvNormalize(doc) {
  const b = doc && typeof doc === "object" ? doc : {};
  return { nodes: Array.isArray(b.nodes) ? b.nodes : [], edges: Array.isArray(b.edges) ? b.edges : [], pan: b.pan && typeof b.pan.x === "number" ? b.pan : { x: 60, y: 40 }, zoom: Number(b.zoom) || 1, updatedAt: b.updatedAt || 0 };
}
function cvBoardsUI() {
  const sel = $("cvBoardSel"); if (!sel) return;
  sel.innerHTML = "";
  for (const b of cvBoards) { const o = document.createElement("option"); o.value = b.id; o.textContent = (b.projectId && projects.some((p) => p.id === b.projectId)) ? "📁 " + b.name : b.name; if (b.id === cvBoardId) o.selected = true; sel.appendChild(o); }
}
// The project a board belongs to: its generations file into that project's gallery
// folder and its prompt-writing picks up the project's instructions.
function cvBoardProjectId() {
  const b = cvBoards.find((x) => x.id === cvBoardId);
  return b && b.projectId && projects.some((p) => p.id === b.projectId) ? b.projectId : null;
}
// Open (or create) the board tied to a project — the "seamless" jump from the popover.
async function cvOpenProjectBoard(p) {
  await cvWhenReady();
  const existing = cvBoards.find((b) => b.projectId === p.id);
  if (existing) { if (existing.id !== cvBoardId) await cvOpenBoard(existing.id); return; }
  try {
    const d = await api("/api/boards", { name: p.name, projectId: p.id, board: { nodes: [], edges: [], pan: { x: 60, y: 40 }, zoom: 1, updatedAt: Date.now() } });
    cvBoards = d.boards || cvBoards;
    await cvOpenBoard(d.id);
    toast("board “" + p.name + "” created — it files renders into this project");
  } catch { toast("couldn't open the project board"); }
}
async function cvOpenBoard(id) {
  cvFlush();   // don't lose edits to the board we're leaving
  let doc = null, name = "";
  try { const d = await api("/api/boards?id=" + encodeURIComponent(id)); doc = d.board; name = d.name || ""; } catch {}
  // Crash-safety reconcile: if the local cache for this board is newer, it wins.
  try {
    const c = JSON.parse(localStorage.getItem(CANVAS_CACHE) || "null");
    if (c && c.id === id && c.board && (c.board.updatedAt || 0) > ((doc && doc.updatedAt) || 0)) { doc = c.board; api("/api/boards", { id, board: doc }).catch(() => {}); }
  } catch {}
  cvBoardId = id; cv = cvNormalize(doc);
  try { localStorage.setItem(BOARD_LAST, id); } catch {}
  cvBoardsUI(); cvRebuildAll();
  return name;
}
async function cvBoardsInit() {
  try { const d = await api("/api/boards"); cvBoards = d.boards || []; } catch { cvBoards = []; }
  if (!cvBoards.length) {
    // First run on this account: migrate the old per-browser board if it has anything,
    // otherwise start fresh. Either way the account now owns "Board 1".
    let legacy = null;
    try { legacy = JSON.parse(localStorage.getItem(CANVAS_KEY) || "null"); } catch {}
    const seed = legacy && Array.isArray(legacy.nodes) && legacy.nodes.length ? legacy : { nodes: [], edges: [], pan: { x: 60, y: 40 }, zoom: 1 };
    try {
      const d = await api("/api/boards", { name: "Board 1", board: { ...seed, updatedAt: Date.now() } });
      cvBoards = d.boards || []; if (legacy && seed === legacy) { toast("your board now lives in your account — it follows you to any computer"); localStorage.removeItem(CANVAS_KEY); }
    } catch { toast("couldn't reach board storage — working locally for now"); cvLoad(); cvRebuildAll(); return; }
  }
  let last = ""; try { last = localStorage.getItem(BOARD_LAST) || ""; } catch {}
  const openId = cvBoards.some((b) => b.id === last) ? last : cvBoards[0].id;
  await cvOpenBoard(openId);
}

/* ---- entering Space mode ---- */
function renderSpace() {
  cvLoad(); cvApply(); cvEmptyUpd();
  if (cvBoardsReady) return;
  cvBoardsReady = true;
  cvBoardsPromise = cvBoardsInit();
}
// Anything that ADDS to the board must wait for the account board to finish opening —
// otherwise the load replaces cv and wipes the just-added node (race on first entry).
async function cvWhenReady() {
  for (let i = 0; i < 40 && !cvBoardsPromise && token; i++) await new Promise((r) => setTimeout(r, 50));
  if (cvBoardsPromise) { try { await cvBoardsPromise; } catch {} }
}

/* wire */
// Single self-contained file now (JS inlined into index.html), so one version marker.
if ($("build")) $("build").textContent = "v" + BUILD;
if ($("verBadge")) $("verBadge").textContent = "PARALLAX v" + BUILD;
initTheme();
setupResizers();
$("loginBtn").onclick = login;
$("p").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
$("logoutBtn").onclick = logout;
$("scrChat").onclick = () => setScreen("chat");
$("scrBoard").onclick = () => setScreen("board");
$("chatToBoard").onclick = () => setScreen("board");
$("chatTurns").addEventListener("scroll", chatJumpUpd, { passive: true });
$("chatJump").onclick = chatScrollBottom;
$("thNew").onclick = () => newThread(threadProjectId(chatThread));
$("chatTitle").onclick = () => renameThread(chatThread);
$("thToggle").onclick = () => {
  const cv = $("chatView"); const col = cv.classList.toggle("tb-collapsed");
  try { localStorage.setItem("plx-threadbar", col ? "0" : "1"); } catch {}
};
$("projBtn").onclick = () => { renderProjects(); show("projModal"); };
$("projClose").onclick = () => hide("projModal");
$("newMvBtn").onclick = newMusicVideo;
$("togClaude").onclick = () => toggleLane("claude");
$("togGpt").onclick = () => toggleLane("gpt");
$("newProjBtn").onclick = () => { hide("projModal"); editingId = null; $("npName").value = ""; $("npInstr").value = ""; $("npType").value = "chat"; $("npTitle").textContent = "NEW PROJECT"; fillNpSkills([]); show("npModal"); };
$("npSave").onclick = saveNP; $("npCancel").onclick = () => { hide("npModal"); editingId = null; };
$("skillsBtn").onclick = openSkills; $("skillsClose").onclick = () => hide("skillsModal");
$("skSave").onclick = saveUserSkill; $("skCancel").onclick = () => hide("skillEditModal"); $("skillEditClose").onclick = () => hide("skillEditModal");
$("infoClose").onclick = () => hide("infoModal");
$("connBtn").onclick = openConnections; $("connClose").onclick = () => hide("connModal");
$("anthropicSave").onclick = () => saveProviderKey("anthropic", "anthropicKey");
$("openaiSave").onclick = () => saveProviderKey("openai", "openaiKey");
/* v45: user-set credit balances (Anthropic/OpenAI expose none via API) */
async function setAcctBalance(provider, inputId) {
  const v = $(inputId).value.trim();
  if (v === "") return;
  const usd = Number(v);
  if (!Number.isFinite(usd) || usd < 0) { toast("enter the dollar amount left on the account"); return; }
  try {
    await api("/api/balances", { provider, usd });
    acctBal[provider] = usd; updateMeters(); $(inputId).value = "";
    toast((provider === "anthropic" ? "Claude" : "GPT") + " balance set — the meter counts down from here");
  } catch { toast("couldn't save the balance"); }
}
$("anthropicBalSave").onclick = () => setAcctBalance("anthropic", "anthropicBal");
$("openaiBalSave").onclick = () => setAcctBalance("openai", "openaiBal");
$("anthropicAdminSave").onclick = () => saveProviderKey("anthropic_admin", "anthropicAdminKey");
$("openaiAdminSave").onclick = () => saveProviderKey("openai_admin", "openaiAdminKey");
$("veniceSave").onclick = () => saveProviderKey("venice", "veniceKey");
$("artcraftSave").onclick = async () => {
  const key = $("artcraftKey").value.trim(), base = $("artcraftBase").value.trim(); if (!key && !base) return;
  const d = await api("/api/connections", { provider: "artcraft", key: key || undefined, base: base || undefined });
  if (d.ok) { $("artcraftKey").value = ""; toast("ArtCraft saved"); openConnections(); loadStatus(); } else toast(d.error || "save failed");
};
$("galBtn").onclick = toggleRefDock; $("refClose").onclick = () => hide("refDock");
$("galTabImg").onclick = () => setGalTab("image"); $("galTabVid").onclick = () => setGalTab("video");
$("galNewFolder").onclick = createFolder;
$("galSortSel").onchange = (e) => { galSort = e.target.value; renderGallery(); };
$("lbClose").onclick = closeLightbox;
$("galLightbox").addEventListener("click", (e) => { if (e.target.id === "galLightbox") closeLightbox(); });
$("refFile").onchange = async (e) => {
  const files = [...e.target.files]; e.target.value = "";
  for (const f of files) {
    if (f.size > 9000000) { toast(`${f.name}: too large (max ~9MB)`); continue; }
    try {
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
      const d = await api("/api/gallery", { dataUrl, name: f.name }); if (!d.ok) toast(d.error || "add failed");
    } catch { toast("couldn't read " + f.name); }
  }
  toast("added to gallery"); loadRefWall();
};
/* Dual Mind panel wiring */
$("chatSend").onclick = () => panelSend(false);
$("chatCollab").onclick = () => panelSend(true);
$("chatText").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); panelSend(false); } });
$("chatFile").onchange = (e) => { collectImages(e.target.files, chatAtts, renderChatAtts); e.target.value = ""; };
$("chatMic").onclick = () => toggleMic($("chatText"), $("chatMic"));
$("chatText").addEventListener("paste", (e) => { const its = [...((e.clipboardData && e.clipboardData.items) || [])].filter((it) => it.type && it.type.startsWith("image/")); if (its.length) { e.preventDefault(); collectImages(its.map((it) => it.getAsFile()).filter(Boolean), chatAtts, renderChatAtts); } });
(function () {
  const panel = $("chatView"); if (!panel) return;
  panel.addEventListener("dragover", (e) => { e.preventDefault(); });
  panel.addEventListener("drop", async (e) => {
    e.preventDefault(); e.stopPropagation();
    const plx = e.dataTransfer.getData("application/x-plx-media");
    if (plx) { try { await routeMediaTo("chat", JSON.parse(plx)); return; } catch {} }
    await dropToAtts(e.dataTransfer, chatAtts, renderChatAtts);
  });
})();

/* ---- drag & drop image references (OS files, pasted data-URLs, or in-app gallery drags) ---- */
// Pull any image payloads out of a DataTransfer: real files first, then a data:/http image
// URL from text/uri-list, text/plain, or an <img src> inside dropped text/html (gallery drag).
function extractDropImages(dt) {
  const files = [...((dt && dt.files) || [])].filter((f) => f && f.type && f.type.startsWith("image/"));
  const urls = [];
  if (!files.length && dt) {
    const uri = (dt.getData("text/uri-list") || "").trim();
    const txt = (dt.getData("text/plain") || "").trim();
    const html = dt.getData("text/html") || "";
    const cand = uri || txt;
    if (/^data:image\//i.test(cand) || /^https?:\/\/\S+\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i.test(cand)) urls.push(cand);
    else { const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html); if (m) urls.push(m[1]); }
  }
  return { files, urls };
}
// Attach whatever was dropped into `arr` (an attachments array) and re-render.
async function dropToAtts(dt, arr, render) {
  const { files, urls } = extractDropImages(dt);
  let n = 0;
  if (files.length) { const before = arr.length; await collectImages(files, arr, render); n += arr.length - before; }
  for (const u of urls) {
    if (/^data:image\//i.test(u)) { const a = dataUrlToAtt(u); if (a) { arr.push(a); n++; } }
    else {
      try { const b = await (await fetch(u)).blob(); if (b && /^image\//.test(b.type)) { const before = arr.length; await collectImages([new File([b], "reference", { type: b.type })], arr, render); n += arr.length - before; } }
      catch { /* cross-origin image — skipped */ }
    }
  }
  if (urls.length) render();
  toast(n ? (n + " reference" + (n > 1 ? "s" : "") + " added") : "no image found in that drop");
  return n;
}
// Page-level guard: without this, dropping an image anywhere the app doesn't handle makes the
// browser NAVIGATE to that image, unloading the app and wiping the composer. Swallow stray drops.
["dragover", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); }, false));
/* v41: space canvas wiring */
(function () {
  const view = $("cvView"); if (!view) return;
  view.addEventListener("pointerdown", cvPointerDown);
  window.addEventListener("pointermove", cvPointerMove);
  window.addEventListener("pointerup", cvPointerUp);
  view.addEventListener("wheel", cvWheel, { passive: false });
  // double-click empty canvas -> place a blank node (Image gen / Video gen / Text chat)
  view.addEventListener("dblclick", (e) => {
    cvLoad();
    if (e.target.closest(".cvnode") || e.target.closest(".cvmenu")) return;
    cvShowMenu(e, null);
  });
  $("cvAddFile").onchange = (e) => { cvAddFiles(e.target.files); e.target.value = ""; };
  $("cvAddTextBtn").onclick = () => cvAddText();
  /* boards: switcher + new/rename/delete; edits flush before leaving a board */
  $("cvBoardSel").onchange = (e) => { if (e.target.value && e.target.value !== cvBoardId) cvOpenBoard(e.target.value); };
  $("cvBoardNew").onclick = async () => {
    const name = (prompt("New board name:") || "").trim() || ("Board " + (cvBoards.length + 1));
    try { const d = await api("/api/boards", { name, board: { nodes: [], edges: [], pan: { x: 60, y: 40 }, zoom: 1, updatedAt: Date.now() } }); cvBoards = d.boards || cvBoards; await cvOpenBoard(d.id); toast("board created"); }
    catch { toast("couldn't create board"); }
  };
  $("cvBoardRen").onclick = async () => {
    if (!cvBoardId) return;
    const cur = cvBoards.find((b) => b.id === cvBoardId);
    const name = (prompt("Rename board:", cur ? cur.name : "") || "").trim(); if (!name) return;
    try { const d = await api("/api/boards", { id: cvBoardId, name }); cvBoards = d.boards || cvBoards; cvBoardsUI(); toast("renamed"); }
    catch { toast("rename failed"); }
  };
  $("cvBoardDel").onclick = async () => {
    if (!cvBoardId) return;
    const cur = cvBoards.find((b) => b.id === cvBoardId);
    if (!confirm(`Delete board “${cur ? cur.name : "this board"}”? Its images and clips stay in your gallery.`)) return;
    try {
      const d = await api("/api/boards?id=" + encodeURIComponent(cvBoardId), null, "DELETE");
      cvBoards = d.boards || []; cvBoardId = null; cvPushPending = false;
      if (!cvBoards.length) { const nd = await api("/api/boards", { name: "Board 1", board: { nodes: [], edges: [], pan: { x: 60, y: 40 }, zoom: 1, updatedAt: Date.now() } }); cvBoards = nd.boards || []; }
      await cvOpenBoard(cvBoards[0].id); toast("board deleted");
    } catch { toast("delete failed"); }
  };
  window.addEventListener("pagehide", cvFlush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") cvFlush(); });
  $("cvResetView").onclick = () => { cvLoad(); cv.pan = { x: 60, y: 40 }; cv.zoom = 1; cvApply(); cvSave(); };
  $("cvClear").onclick = () => {
    cvLoad();
    if (cv.nodes.length && !confirm("Clear the whole board? Generated and uploaded media stays in your gallery.")) return;
    cv.nodes = []; cv.edges = []; cvSave();
    $("cvNodes").innerHTML = ""; for (const k in cvEls) delete cvEls[k];
    cvDrawEdges(); cvEmptyUpd();
  };
  // paste an image anywhere → it lands on the board (unless you're pasting into a
  // text field, the Dual Mind panel, or an open modal)
  document.addEventListener("paste", (e) => {
    const t = e.target;
    if (t && ((t.closest && (t.closest("#chatView") || t.closest(".modal") || t.closest("#refDock"))) || /^(INPUT|TEXTAREA)$/.test(t.tagName || ""))) return;
    const its = [...((e.clipboardData && e.clipboardData.items) || [])].filter((it) => it.type && it.type.startsWith("image/"));
    if (its.length) { e.preventDefault(); cvAddFiles(its.map((it) => it.getAsFile()).filter(Boolean)); }
  });
  // drops: gallery drags (in-app payload — images AND videos), OS image files, or an
  // image dragged straight off another website (URL / HTML payloads). Works anywhere
  // on the stage, with a full-canvas "drop to add" ring while dragging over it.
  const stage = $("spaceStage");
  stage.addEventListener("dragenter", (e) => { e.preventDefault(); view.classList.add("dropover"); });
  stage.addEventListener("dragover", (e) => { e.preventDefault(); view.classList.add("dropover"); });
  stage.addEventListener("dragleave", (e) => { if (!stage.contains(e.relatedTarget)) view.classList.remove("dropover"); });
  stage.addEventListener("drop", async (e) => {
    e.preventDefault(); e.stopPropagation(); view.classList.remove("dropover"); cvLoad();
    const p = cvWorldPt(e);
    const plx = e.dataTransfer.getData("application/x-plx-media");
    if (plx) {
      try {
        const item = JSON.parse(plx);
        if (item.type === "video") { cvAddVideo(item.src, item.id || null, p.x - 150, p.y - 90, null); toast("clip on the board"); return; }
        const att = await srcToImgAtt(item.src); if (!att) { toast("couldn't read image"); return; }
        await cvAddImage(att.dataUrl, item.id || null, p.x - 140, p.y - 100); return;
      } catch {}
    }
    const { files, urls } = extractDropImages(e.dataTransfer);
    if (files.length) { await cvAddFiles(files, { x: p.x - 140, y: p.y - 100 }); return; }
    for (const u of urls) {
      const att = await srcToImgAtt(u);
      if (att) { await cvAddImage(att.dataUrl, null, p.x - 140, p.y - 100); toast("image on the board"); return; }
    }
    if (urls.length) toast("couldn't read that image (the site may block cross-origin fetch) — save it and drop the file instead");
    else toast("no image found in that drop");
  });
})();

for (const m of ["skillsModal","infoModal","connModal","npModal","skillEditModal","projModal"]) $(m).addEventListener("click", (e) => { if (e.target.id === m) hide(m); });

if (token) showApp();
