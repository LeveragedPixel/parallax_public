// functions/api/spend.js — REAL org spend from the providers' cost APIs.
// Anthropic and OpenAI only expose spend to ADMIN keys (a regular API key can't read
// billing at all) — the user adds those in Connections. Venice reports a live balance
// elsewhere (/api/connections), so it isn't needed here.
// GET /api/spend -> { ok, anthropic: { monthUsd|null, error? }, openai: { monthUsd|null, error? } }
// Month-to-date, UTC. Errors come back as readable strings, never thrown HTML (gotcha #6).

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";
import { getKeys, openaiCredits, veniceBalance } from "./_providers.js";

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }

const monthStart = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; };

// Amounts arrive in slightly different shapes per provider/version — dig out a number.
function amt(x) {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  if (typeof x === "string") { const n = Number(x); return Number.isFinite(n) ? n : 0; }
  if (typeof x === "object") return amt(x.value != null ? x.value : x.amount);
  return 0;
}

async function anthropicSpend(adminKey) {
  const startISO = new Date(monthStart() * 1000).toISOString();
  let total = 0, page = null;
  for (let i = 0; i < 5; i++) {
    const u = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    u.searchParams.set("starting_at", startISO);
    u.searchParams.set("limit", "31");
    if (page) u.searchParams.set("page", page);
    const r = await fetch(u, { headers: { "x-api-key": adminKey, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(15000) });
    const raw = await r.text();
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) throw new Error("Anthropic rejected the admin key — spend needs an ADMIN key (sk-ant-admin…), not a regular API key");
      throw new Error(`Anthropic cost API ${r.status}: ${raw.slice(0, 120)}`);
    }
    let d; try { d = JSON.parse(raw); } catch { throw new Error("Anthropic cost API sent an unreadable response"); }
    for (const bucket of d.data || []) for (const res of bucket.results || []) total += amt(res);
    if (!d.has_more || !d.next_page) break;
    page = d.next_page;
  }
  return total;
}

async function openaiSpend(adminKey) {
  let total = 0, page = null;
  for (let i = 0; i < 5; i++) {
    const u = new URL("https://api.openai.com/v1/organization/costs");
    u.searchParams.set("start_time", String(monthStart()));
    u.searchParams.set("limit", "31");
    if (page) u.searchParams.set("page", page);
    const r = await fetch(u, { headers: { Authorization: "Bearer " + adminKey }, signal: AbortSignal.timeout(15000) });
    const raw = await r.text();
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) throw new Error("OpenAI rejected the admin key — spend needs an ADMIN key (org owner → API keys → Admin), not a project key");
      throw new Error(`OpenAI cost API ${r.status}: ${raw.slice(0, 120)}`);
    }
    let d; try { d = JSON.parse(raw); } catch { throw new Error("OpenAI cost API sent an unreadable response"); }
    for (const bucket of d.data || []) for (const res of bucket.results || []) total += amt(res);
    if (!d.has_more || !d.next_page) break;
    page = d.next_page;
  }
  return total;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) return json({ error: "unauthorized" }, 401);
  const keys = await getKeys(env, userFromToken(token));

  const out = {
    ok: true,
    anthropic: { monthUsd: null, creditUsd: null, creditNote: "Anthropic exposes no remaining-credit endpoint to API or admin keys (still an open request) — set your balance in Connections and Parallax counts down from real usage." },
    openai: { monthUsd: null, creditUsd: null },
    venice: { usd: null, vcu: null, diem: null },
  };
  await Promise.all([
    // month-to-date spend (admin keys only)
    (async () => {
      if (!keys.anthropicAdmin) return;
      try { out.anthropic.monthUsd = await anthropicSpend(keys.anthropicAdmin); }
      catch (e) { out.anthropic.error = String(e.message || e); }
    })(),
    (async () => {
      if (!keys.openaiAdmin) return;
      try { out.openai.monthUsd = await openaiSpend(keys.openaiAdmin); }
      catch (e) { out.openai.error = String(e.message || e); }
    })(),
    // REMAINING credit: OpenAI's credit-grants surface (admin key first, then the plain key)
    (async () => {
      const k = keys.openaiAdmin || keys.openai;
      if (!k) return;
      try { const c = await openaiCredits(k); out.openai.creditUsd = c.available; out.openai.creditGranted = c.granted; }
      catch (e) { out.openai.creditError = String(e.message || e); }
    })(),
    // Venice reports real remaining balances
    (async () => {
      if (!keys.venice) return;
      try { const b = await veniceBalance(keys.venice); out.venice = { usd: b.usd, vcu: b.vcu, diem: b.diem }; }
      catch (e) { out.venice.error = String(e.message || e); }
    })(),
  ]);
  return json(out);
}
