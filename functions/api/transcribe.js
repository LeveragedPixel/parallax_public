// functions/api/transcribe.js — POST /api/transcribe
// Transcribes an uploaded audio file (a song) to text/lyrics via OpenAI Whisper,
// using the user's own OpenAI key (server-side). Claude can't hear audio, so this is
// how a song's lyrics get into a prompt. Send multipart/form-data with a `file` field.

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";
import { getKeys } from "./_providers.js";

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) return json({ error: "unauthorized" }, 401);

  const keys = await getKeys(env, userFromToken(token));
  if (!keys.openai) return json({ ok: false, error: "OpenAI key not connected — add it in Connections (it powers audio transcription)." });

  let form;
  try { form = await request.formData(); } catch { return json({ error: "expected multipart form-data with a `file`" }, 400); }
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "no audio file provided" }, 400);
  const model = form.get("model") || "whisper-1";

  const out = new FormData();
  out.append("file", file, file.name || "audio");
  out.append("model", model);
  const lang = form.get("language"); if (lang) out.append("language", lang);

  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.openai}` },
      body: out,
      signal: AbortSignal.timeout(120000),
    });
    const text = await res.text();
    let d = {}; try { d = JSON.parse(text); } catch { d = { text }; }
    if (!res.ok) return json({ ok: false, error: "transcription failed: " + ((d.error && d.error.message) || ("HTTP " + res.status)) });
    return json({ ok: true, text: (d.text || "").trim() });
  } catch (e) {
    return json({ ok: false, error: "transcription error: " + (e.name === "TimeoutError" ? "timed out (long file?)" : (e.message || "unknown")) });
  }
}
