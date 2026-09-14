// tests/demo-isolation.mjs — the demo account must not be able to spend the operator's money.
//
// This is the test that matters most in this repo. Parallax lets anyone log in without a
// password, and getKeys() falls back to the operator's environment keys. If those two facts
// ever meet, the first stranger to press Generate spends the operator's credit, uncapped,
// with nothing in the logs to say who did it. Everything here exists to keep them apart.
//
//   node tests/demo-isolation.mjs

import { getKeys } from "../functions/api/_providers.js";
import { isDemo, newDemoUser, demoEnabled, demoSharesKeys } from "../functions/api/_demo.js";
import { onRequestPost as login } from "../functions/api/login.js";
import { verifyToken } from "../functions/api/_verify.js";
import { userFromToken } from "../functions/api/_session.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? pass++ : (fail++, console.log("  FAIL:", msg)); };

const ENV = {
  ANTHROPIC_API_KEY: "sk-ant-OWNER", OPENAI_API_KEY: "sk-OWNER",
  VENICE_API_KEY: "vn-OWNER", ANTHROPIC_ADMIN_KEY: "sk-ant-ADMIN",
  SESSION_SECRET: "test-secret", APP_USER: "operator", APP_PASS: "hunter2",
};
const kvWith = (map) => ({ get: async (k) => map[k] || null });
const post = (env, body) => login({
  env,
  request: new Request("https://x/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }),
});

/* ---- identity ---- */
const demo = newDemoUser();
ok(isDemo(demo), "a minted id is recognised as a demo id");
ok(!isDemo("operator"), "the operator is not treated as a demo user");
ok(newDemoUser() !== newDemoUser(), "every demo login gets its OWN workspace, not a shared one");
ok(demoEnabled({}), "the demo is on by default");
ok(!demoEnabled({ DEMO_MODE: "off" }), "DEMO_MODE=off turns the demo off");
ok(!demoSharesKeys({}), "the operator's keys are NOT shared by default");

/* ---- key resolution ---- */
let k = await getKeys({ ...ENV, PARALLAX_KV: null }, "operator");
ok(k.anthropic === "sk-ant-OWNER" && k.openai === "sk-OWNER", "the operator still inherits env keys");
ok(k.anthropicAdmin === "sk-ant-ADMIN", "the operator still gets the admin key");

k = await getKeys({ ...ENV, PARALLAX_KV: null }, demo);
ok(k.anthropic === "" && k.openai === "" && k.venice === "", "a demo user inherits NO env keys");
ok(k.anthropicAdmin === "", "a demo user never gets the admin key");

k = await getKeys(
  { ...ENV, PARALLAX_KV: kvWith({ ["keys:" + demo]: JSON.stringify({ openai: "sk-VISITOR" }) }) },
  demo,
);
ok(k.openai === "sk-VISITOR", "a demo user's OWN key is used — the demo is usable BYO-key");
ok(k.anthropic === "", "connecting one provider does not unlock the others");

k = await getKeys({ ...ENV, DEMO_SHARED_KEYS: "on", PARALLAX_KV: null }, demo);
ok(k.openai === "sk-OWNER", "DEMO_SHARED_KEYS=on lets the operator fund the demo");
ok(k.anthropicAdmin === "", "DEMO_SHARED_KEYS never shares the ADMIN key — that reads org billing");

/* ---- the login route ---- */
let d = await (await post(ENV, { username: "demo" })).json();
ok(d.ok && d.demo === true, "username 'demo' with no password logs in");
ok(isDemo(userFromToken(d.token)), "the issued token carries a demo identity");
ok(await verifyToken(d.token, ENV.SESSION_SECRET), "the demo token is a valid signed session");
ok(d.exp - Date.now() < 25 * 3600 * 1000, "a demo session expires within a day, not 30 of them");

const a = await (await post(ENV, { username: "demo" })).json();
const b = await (await post(ENV, { username: "demo" })).json();
ok(userFromToken(a.token) !== userFromToken(b.token), "two visitors never land in the same workspace");

d = await (await post({ ...ENV, DEMO_MODE: "off" }, { username: "demo" })).json();
ok(!d.ok, "with DEMO_MODE=off the demo login is refused");

d = await (await post(ENV, { username: "demo", password: "anything" })).json();
ok(!d.ok, "'demo' WITH a password is not a free pass — it falls through to a real credential check");

d = await (await post(ENV, { username: "operator", password: "hunter2" })).json();
ok(d.ok && !d.demo && userFromToken(d.token) === "operator", "the operator login still works");

d = await (await post(ENV, { username: "operator", password: "wrong" })).json();
ok(!d.ok, "a wrong operator password is still refused");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
