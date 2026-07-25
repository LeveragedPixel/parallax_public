// functions/api/repo.js — Studio Console engine.
// A full GitHub repo manager behind the site login. The GitHub token lives ONLY in
// Cloudflare env (GITHUB_TOKEN) — it is never sent to the browser and never leaves the server.
//
// POST /api/repo  { action, ... }   (Bearer session token required)
//
// Actions:
//   repos.list / repos.save / repos.delete   — manage the multi-project list (KV)
//   commits            — recent commits for a repo/branch
//   branches           — list branches ; branch.create — new branch from a base
//   tree               — list all files (blob paths) on a branch
//   file               — read one file's content + sha
//   commit             — ATOMIC multi-file publish (git data API: blobs→tree→commit→ref)
//   revert             — one-click rollback: restore a previous commit's tree as a new commit
//   search             — code search within the repo
//   deploys            — optional Cloudflare Pages deployment status (needs CF_* env)
//   log                — publish/rollback audit trail (KV)

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";

const GH = "https://api.github.com";
function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Parallax-StudioConsole",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gh(token, path, opts = {}, attempt = 0) {
  let res;
  try {
    res = await fetch(GH + path, { ...opts, headers: ghHeaders(token), signal: AbortSignal.timeout(20000) });
  } catch (e) {
    // Network/timeout hiccup — GitHub commit steps are content-addressed (safe to retry).
    if (attempt < 3) { await sleep(500 * (attempt + 1)); return gh(token, path, opts, attempt + 1); }
    throw new Error(`GitHub unreachable: ${e.name === "TimeoutError" ? "timed out" : (e.message || e.name)}`);
  }
  // Transient GitHub-side errors (502/503/504) or rate-limit — back off and retry.
  if ((res.status === 502 || res.status === 503 || res.status === 504 || res.status === 429) && attempt < 3) {
    await sleep(600 * (attempt + 1));
    return gh(token, path, opts, attempt + 1);
  }
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) { const e = new Error(`GitHub ${res.status}: ${(data && data.message) || text || res.status}`); e.status = res.status; throw e; }
  return data;
}
// UTF-8-safe base64 decode (Workers atob is latin1).
function b64ToUtf8(b64) {
  const bin = atob((b64 || "").replace(/\n/g, "")); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ---- multi-project config (KV) ---- */
async function loadRepos(env, user) {
  let list = [];
  if (env.PARALLAX_KV) { const raw = await env.PARALLAX_KV.get("repos:" + user); if (raw) { try { list = JSON.parse(raw) || []; } catch {} } }
  if (!list.length && env.GITHUB_REPO) {
    const [owner, repo] = env.GITHUB_REPO.split("/");
    list = [{ id: "default", name: repo || env.GITHUB_REPO, owner, repo, branch: env.GITHUB_BRANCH || "main", liveUrl: env.SITE_URL || "" }];
  }
  return list;
}
async function saveRepos(env, user, list) { if (env.PARALLAX_KV) await env.PARALLAX_KV.put("repos:" + user, JSON.stringify(list.slice(0, 50))); }
async function logEvent(env, user, ev) {
  if (!env.PARALLAX_KV) return;
  let log = []; const raw = await env.PARALLAX_KV.get("repolog:" + user); if (raw) { try { log = JSON.parse(raw) || []; } catch {} }
  log.unshift({ ...ev, t: Date.now() });
  await env.PARALLAX_KV.put("repolog:" + user, JSON.stringify(log.slice(0, 200)));
}
function target(body, repos) {
  const r = repos.find((x) => x.id === body.repoId) || repos[0];
  if (!r) throw new Error("no repo configured — add one in the console");
  return { owner: body.owner || r.owner, repo: body.repo || r.repo, branch: body.branch || r.branch || "main" };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) return json({ error: "unauthorized" }, 401);
  const user = userFromToken(token);

  let body; try { body = await request.json(); } catch { return json({ error: "bad body" }, 400); }
  const action = body.action;
  const ghToken = env.GITHUB_TOKEN;

  try {
    // ----- config / log actions (no GitHub token needed) -----
    if (action === "repos.list") return json({ ok: true, repos: await loadRepos(env, user), tokenSet: !!ghToken });
    if (action === "repos.save") {
      const repos = await loadRepos(env, user); const r = body.repo || {};
      if (!r.owner || !r.repo) return json({ error: "owner and repo required" }, 400);
      r.id = r.id || ("r_" + Math.random().toString(16).slice(2, 10));
      const i = repos.findIndex((x) => x.id === r.id);
      if (i >= 0) repos[i] = { ...repos[i], ...r }; else repos.push(r);
      await saveRepos(env, user, repos); return json({ ok: true, repos });
    }
    if (action === "repos.delete") { let repos = await loadRepos(env, user); repos = repos.filter((x) => x.id !== body.id); await saveRepos(env, user, repos); return json({ ok: true, repos }); }
    if (action === "log") { let log = []; if (env.PARALLAX_KV) { const raw = await env.PARALLAX_KV.get("repolog:" + user); if (raw) { try { log = JSON.parse(raw) || []; } catch {} } } return json({ ok: true, log }); }

    // ----- everything below needs the GitHub token -----
    if (!ghToken) return json({ ok: false, error: "GitHub token not set — add GITHUB_TOKEN in your Cloudflare Pages environment variables." });
    const repos = await loadRepos(env, user);
    const { owner, repo, branch } = target(body, repos);
    const base = `/repos/${owner}/${repo}`;

    if (action === "commits") {
      const d = await gh(ghToken, `${base}/commits?sha=${encodeURIComponent(branch)}&per_page=${Math.min(30, body.limit || 20)}`);
      return json({ ok: true, commits: d.map((c) => ({ sha: c.sha, message: c.commit.message, author: (c.commit.author || {}).name, date: (c.commit.author || {}).date, url: c.html_url })) });
    }
    if (action === "branches") { const d = await gh(ghToken, `${base}/branches?per_page=100`); return json({ ok: true, branches: d.map((b) => ({ name: b.name, sha: b.commit.sha })) }); }
    if (action === "branch.create") {
      const from = body.from || branch;
      const ref = await gh(ghToken, `${base}/git/ref/heads/${encodeURIComponent(from)}`);
      await gh(ghToken, `${base}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${body.name}`, sha: ref.object.sha }) });
      return json({ ok: true, created: body.name });
    }
    if (action === "tree") {
      const d = await gh(ghToken, `${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      const files = (d.tree || []).filter((t) => t.type === "blob").map((t) => ({ path: t.path, size: t.size }));
      return json({ ok: true, files, truncated: d.truncated });
    }
    if (action === "file") {
      const p = String(body.path || "").split("/").map(encodeURIComponent).join("/");
      const d = await gh(ghToken, `${base}/contents/${p}?ref=${encodeURIComponent(branch)}`);
      const binary = /\.(png|jpe?g|gif|webp|ico|mp4|mov|zip|pdf|woff2?)$/i.test(body.path || "");
      return json({ ok: true, path: body.path, sha: d.sha, size: d.size, content: binary ? "" : b64ToUtf8(d.content), binary });
    }

    if (action === "commit") {
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) return json({ error: "no files to publish" }, 400);
      const message = (body.message || "Update via Studio Console").slice(0, 500);
      const refD = await gh(ghToken, `${base}/git/ref/heads/${encodeURIComponent(branch)}`);
      const latest = refD.object.sha;
      const commitD = await gh(ghToken, `${base}/git/commits/${latest}`);
      const tree = [];
      for (const f of files) {
        if (f.delete) { tree.push({ path: f.path, mode: "100644", type: "blob", sha: null }); continue; }
        const blob = await gh(ghToken, `${base}/git/blobs`, { method: "POST", body: JSON.stringify({ content: f.content, encoding: f.base64 ? "base64" : "utf-8" }) });
        tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
      }
      const treeD = await gh(ghToken, `${base}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: commitD.tree.sha, tree }) });
      const newCommit = await gh(ghToken, `${base}/git/commits`, { method: "POST", body: JSON.stringify({ message, tree: treeD.sha, parents: [latest] }) });
      await gh(ghToken, `${base}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: JSON.stringify({ sha: newCommit.sha }) });
      await logEvent(env, user, { action: "publish", repo: `${owner}/${repo}`, branch, message, sha: newCommit.sha, files: files.map((f) => (f.delete ? "− " : "") + f.path) });
      return json({ ok: true, sha: newCommit.sha, url: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`, count: files.length });
    }

    if (action === "revert") {
      const to = body.sha; if (!to) return json({ error: "target sha required" }, 400);
      const targetCommit = await gh(ghToken, `${base}/git/commits/${to}`);
      const refD = await gh(ghToken, `${base}/git/ref/heads/${encodeURIComponent(branch)}`);
      const newCommit = await gh(ghToken, `${base}/git/commits`, { method: "POST", body: JSON.stringify({ message: `Rollback to ${to.slice(0, 7)} · Studio Console`, tree: targetCommit.tree.sha, parents: [refD.object.sha] }) });
      await gh(ghToken, `${base}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: JSON.stringify({ sha: newCommit.sha }) });
      await logEvent(env, user, { action: "rollback", repo: `${owner}/${repo}`, branch, sha: newCommit.sha, to });
      return json({ ok: true, sha: newCommit.sha, url: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}` });
    }

    if (action === "search") {
      const q = encodeURIComponent(`${body.q || ""} repo:${owner}/${repo}`);
      const d = await gh(ghToken, `/search/code?q=${q}&per_page=20`);
      return json({ ok: true, results: (d.items || []).map((i) => ({ path: i.path, url: i.html_url })) });
    }

    if (action === "deploys") {
      if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_PAGES_PROJECT)
        return json({ ok: true, configured: false, note: "Optional: add CF_API_TOKEN, CF_ACCOUNT_ID, CF_PAGES_PROJECT in Cloudflare env to show live deploy status." });
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${env.CF_PAGES_PROJECT}/deployments?per_page=10`, { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, signal: AbortSignal.timeout(15000) });
      const d = await r.json();
      if (!r.ok) return json({ ok: false, error: "Cloudflare: " + ((d.errors && d.errors[0] && d.errors[0].message) || r.status) });
      const deploys = (d.result || []).map((x) => ({ id: x.id, status: (x.latest_stage && x.latest_stage.status) || "unknown", stage: (x.latest_stage && x.latest_stage.name) || "", created: x.created_on, url: x.url, env: x.environment, commit: (x.deployment_trigger && x.deployment_trigger.metadata && x.deployment_trigger.metadata.commit_hash || "").slice(0, 7) }));
      return json({ ok: true, configured: true, deploys });
    }

    return json({ error: "unknown action: " + action }, 400);
  } catch (e) {
    return json({ ok: false, error: e.message || "repo error", status: e.status || 500 });
  }
}
