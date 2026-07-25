// functions/api/_llm.js
// Shared LLM helpers used by the non-streaming pipelines (video, image) and the
// streaming chat lane. Keys are read from env by the callers and passed in — never
// exposed to the browser.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch() with a small retry on transient overload / rate-limit statuses.
// This is half the fix for v1's "Claude lane sometimes returns blank": Anthropic
// intermittently 429/529s in bursts, and a single quiet retry absorbs most of them.
// (The other half is the front-end actually rendering error events — see chat.js.)
export async function fetchWithRetry(url, init, opts = {}) {
  const retries = opts.retries ?? 1;
  const on = opts.on ?? [429, 500, 529];
  let res = await fetch(url, init);
  let attempt = 0;
  while (!res.ok && on.includes(res.status) && attempt < retries) {
    attempt++;
    await sleep(500 * attempt);
    res = await fetch(url, init);
  }
  return res;
}

// Non-streaming Claude call. `content` is an Anthropic-shaped content array
// (text and/or image blocks). Returns the concatenated text output.
export async function claudeComplete(apiKey, model, system, content, maxTokens = 4096) {
  if (!apiKey) throw new Error("Claude key not configured");
  const payload = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  };
  if (system && system.trim()) payload.system = system.trim();

  const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 180)}`);
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
