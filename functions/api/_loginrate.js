// functions/api/_loginrate.js — attempt limiting for /api/login.
//
// The login route compares a username and password straight against environment variables.
// That is fine as far as it goes, but with no attempt counter a script can try passwords as
// fast as the network allows, forever. This turns that into a few tries and then a wall.
//
// Only FAILURES count, and a success clears the record: the operator logging in normally can
// never lock themselves out, no matter how often they sign in.
//
// Failing OPEN is deliberate. If KV is unavailable the choice is "briefly unlimited attempts"
// or "the operator cannot get into their own app". A storage hiccup must not become a lockout.

const KEY = (ip) => "login_rl:" + ip;

export const MAX_FAILS = 8;
export const WINDOW_MS = 15 * 60 * 1000;

// Called BEFORE checking credentials. { ok:false } means refuse without even looking.
export async function checkLoginRate(env, ip, now = Date.now()) {
  if (!env || !env.PARALLAX_KV || !ip) return { ok: true, remaining: MAX_FAILS };
  try {
    const raw = await env.PARALLAX_KV.get(KEY(ip));
    if (!raw) return { ok: true, remaining: MAX_FAILS };
    const rec = JSON.parse(raw);
    if (!rec || now - rec.start > WINDOW_MS) return { ok: true, remaining: MAX_FAILS };
    if (rec.n >= MAX_FAILS) {
      return { ok: false, remaining: 0, retryInMin: Math.max(1, Math.ceil((WINDOW_MS - (now - rec.start)) / 60000)) };
    }
    return { ok: true, remaining: MAX_FAILS - rec.n };
  } catch {
    return { ok: true, remaining: MAX_FAILS };
  }
}

// Called after a WRONG password. The window starts at the first failure and does not slide,
// so a patient attacker gets MAX_FAILS per window rather than MAX_FAILS per attempt.
export async function recordLoginFailure(env, ip, now = Date.now()) {
  if (!env || !env.PARALLAX_KV || !ip) return;
  try {
    const raw = await env.PARALLAX_KV.get(KEY(ip));
    let rec = null;
    if (raw) { try { rec = JSON.parse(raw); } catch {} }
    const fresh = !rec || now - rec.start > WINDOW_MS;
    const next = fresh ? { start: now, n: 1 } : { start: rec.start, n: rec.n + 1 };
    await env.PARALLAX_KV.put(KEY(ip), JSON.stringify(next), {
      expirationTtl: Math.ceil(WINDOW_MS / 1000),
    });
  } catch { /* a failed write must not break the login response */ }
}

// Called after a CORRECT password, so normal use never accumulates toward the limit.
export async function clearLoginFailures(env, ip) {
  if (!env || !env.PARALLAX_KV || !ip) return;
  try { await env.PARALLAX_KV.delete(KEY(ip)); } catch {}
}

export const ipOf = (request) => {
  try { return request.headers.get("CF-Connecting-IP") || ""; } catch { return ""; }
};
