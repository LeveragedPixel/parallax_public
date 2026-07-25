// functions/api/_verify.js
// Shared helper: verify the session token issued by login.js.
// Not a route itself (underscore prefix), imported by the other functions.

export async function verifyToken(token, secret) {
  if (!token || !token.includes(".")) return false;
  const [b64payload, sig] = token.split(".");
  let payload;
  try {
    payload = atob(b64payload);
  } catch {
    return false;
  }
  const expected = await hmac(payload, secret);
  if (!timingSafeEqualHex(sig, expected)) return false;

  const parts = payload.split(".");
  const exp = parseInt(parts[parts.length - 1], 10);
  if (!exp || Date.now() > exp) return false;
  return true;
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function hmac(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  return [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
