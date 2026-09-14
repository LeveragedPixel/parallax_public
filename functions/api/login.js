// functions/api/login.js
// Cloudflare Pages Function — POST /api/login
// Validates username + password against environment variables, then issues a signed
// HMAC session token the browser stores.
//
// Env var names are accepted under BOTH conventions so the v1 README/code mismatch
// (AUTH_USERNAME/AUTH_PASSWORD in the docs vs APP_USER/APP_PASS in the code) can never
// silently break login again. Set either pair.
//
// There is also a passwordless DEMO login: username "demo", no password. It mints a fresh
// throwaway workspace per visitor rather than a shared one, and the account it issues is
// deliberately less privileged than the operator's — see _demo.js for exactly how.

import { demoEnabled, newDemoUser, DEMO_TTL_MS } from "./_demo.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  const inUser = (body?.username ?? "").trim();
  const inPass = (body?.password ?? "").trim();
  const envUser = (env.APP_USER ?? env.AUTH_USERNAME ?? "").trim();
  const envPass = (env.APP_PASS ?? env.AUTH_PASSWORD ?? "").trim();

  // ---- demo: username "demo", no password ----
  // Checked BEFORE the operator credentials so a deployment with no APP_USER/APP_PASS set
  // is still usable. A demo instance that refuses everyone because its owner never
  // configured a login would be a confusing way to fail.
  if (/^demo$/i.test(inUser) && !inPass) {
    if (!demoEnabled(env)) return json({ error: "The demo is turned off on this instance." }, 403);
    if (!env.SESSION_SECRET) {
      return json({ error: "Server not configured: missing SESSION_SECRET" }, 500);
    }
    const user = newDemoUser();
    const exp = Date.now() + DEMO_TTL_MS;
    try {
      const token = await signToken(user, exp, env.SESSION_SECRET);
      return json({ ok: true, token, exp, demo: true, user });
    } catch (err) {
      return json({ error: "Token signing failed: " + (err.message || "unknown") }, 500);
    }
  }

  if (!envUser || !envPass) {
    return json({ error: "Server not configured: set APP_USER/APP_PASS (or AUTH_USERNAME/AUTH_PASSWORD)" }, 500);
  }
  if (inUser !== envUser || inPass !== envPass) {
    return json({ error: "Invalid login" }, 401);
  }
  if (!env.SESSION_SECRET) {
    return json({ error: "Server not configured: missing SESSION_SECRET" }, 500);
  }

  try {
    const exp = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
    const token = await signToken(inUser, exp, env.SESSION_SECRET);
    return json({ ok: true, token, exp });
  } catch (err) {
    return json({ error: "Token signing failed: " + (err.message || "unknown") }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function signToken(username, exp, secret) {
  const payload = `${username}.${exp}`;
  const sig = await hmac(payload, secret);
  return `${btoa(payload)}.${sig}`;
}

async function hmac(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
