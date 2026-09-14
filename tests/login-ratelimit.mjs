// tests/login-ratelimit.mjs — /api/login must stop a brute force, and must never lock out
// the operator. Run: node tests/login-ratelimit.mjs

import { onRequestPost as login } from "../functions/api/login.js";
import { MAX_FAILS, WINDOW_MS } from "../functions/api/_loginrate.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("  FAIL:", m)); };

// a KV stub good enough for the counter: get/put/delete over a Map
const makeKV = () => { const m = new Map(); return {
  store: m,
  get: async (k) => (m.has(k) ? m.get(k) : null),
  put: async (k, v) => void m.set(k, v),
  delete: async (k) => void m.delete(k),
}; };

const ENV = () => ({ APP_USER: "operator", APP_PASS: "hunter2", SESSION_SECRET: "s", PARALLAX_KV: makeKV() });
const req = (body, ip = "1.2.3.4") => new Request("https://x/api/login", {
  method: "POST",
  headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
  body: JSON.stringify(body),
});
const tryLogin = async (env, body, ip) => {
  const r = await login({ env, request: req(body, ip) });
  return { status: r.status, body: await r.json() };
};

/* ---- every response the browser reads must be HTTP 200 (GOTCHA #6) ---- */
let env = ENV();
let r = await tryLogin(env, { username: "operator", password: "wrong" });
ok(r.status === 200, "a failed login is still HTTP 200, so the message survives Cloudflare");
ok(r.body.ok === false && !!r.body.error, "...and carries the reason in the body");

r = await tryLogin(env, { username: "operator", password: "hunter2" });
ok(r.status === 200 && r.body.ok === true && !!r.body.token, "a correct login returns a token");

/* ---- the wall ---- */
env = ENV();
for (let i = 0; i < MAX_FAILS; i++) await tryLogin(env, { username: "operator", password: "guess" + i });
r = await tryLogin(env, { username: "operator", password: "guess-again" });
ok(r.body.ok === false, `attempt ${MAX_FAILS + 1} is refused`);
ok(/too many/i.test(r.body.error), "...and says so plainly: " + JSON.stringify(r.body.error));

// the crucial one: being blocked must not be bypassable by suddenly knowing the password,
// because otherwise the limiter only slows down wrong guesses it was already going to reject.
r = await tryLogin(env, { username: "operator", password: "hunter2" });
ok(r.body.ok === false, "even the CORRECT password is refused while the block is active");

/* ---- the block is per IP ---- */
r = await tryLogin(env, { username: "operator", password: "hunter2" }, "9.9.9.9");
ok(r.body.ok === true, "a different IP is unaffected by someone else's failures");

/* ---- the operator can never lock themselves out ---- */
env = ENV();
for (let i = 0; i < MAX_FAILS * 3; i++) {
  await tryLogin(env, { username: "operator", password: "typo" });
  const good = await tryLogin(env, { username: "operator", password: "hunter2" });
  if (!good.body.ok) { ok(false, `success after a typo failed on round ${i}`); break; }
}
ok(true, "a success clears the count — typing it wrong then right, repeatedly, never locks out");

/* ---- the window expires ---- */
env = ENV();
for (let i = 0; i < MAX_FAILS; i++) await tryLogin(env, { username: "operator", password: "x" });
ok((await tryLogin(env, { username: "operator", password: "hunter2" })).body.ok === false, "blocked inside the window");
for (const [k, v] of env.PARALLAX_KV.store) {                       // rewind the window
  const rec = JSON.parse(v); rec.start -= WINDOW_MS + 1000;
  env.PARALLAX_KV.store.set(k, JSON.stringify(rec));
}
ok((await tryLogin(env, { username: "operator", password: "hunter2" })).body.ok === true, "unblocked once the window passes");

/* ---- a storage outage must not lock the operator out ---- */
const broken = { APP_USER: "operator", APP_PASS: "hunter2", SESSION_SECRET: "s",
  PARALLAX_KV: { get: async () => { throw new Error("kv down"); },
                 put: async () => { throw new Error("kv down"); },
                 delete: async () => { throw new Error("kv down"); } } };
r = await tryLogin(broken, { username: "operator", password: "hunter2" });
ok(r.body.ok === true, "with KV unavailable the limiter fails OPEN — no lockout from a storage hiccup");

/* ---- no KV bound at all (a fresh deployment) ---- */
r = await tryLogin({ APP_USER: "operator", APP_PASS: "hunter2", SESSION_SECRET: "s" },
                   { username: "operator", password: "hunter2" });
ok(r.body.ok === true, "login still works with no KV binding at all");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
