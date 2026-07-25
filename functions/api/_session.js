// functions/api/_session.js
// Shared helpers: pull the bearer token from a request and derive the username.
// navigator.sendBeacon() cannot set headers, so we also accept ?t= as a fallback.

export function tokenFrom(request) {
  const hdr = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (hdr) return hdr;
  try {
    return new URL(request.url).searchParams.get("t") || "";
  } catch {
    return "";
  }
}

// The token payload is base64("<user>.<exp>"), so the username is the first segment.
export function userFromToken(token) {
  try {
    const payload = atob(token.split(".")[0]);
    return payload.split(".")[0] || "user";
  } catch {
    return "user";
  }
}
