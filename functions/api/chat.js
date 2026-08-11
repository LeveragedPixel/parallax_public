// functions/api/chat.js
// Cloudflare Pages Function — POST /api/chat
// Holds the API keys server-side and proxies a streaming call to ONE model.
// The front-end calls this once per lane (Claude + GPT stream independently).
//
// New in 2.0 vs v1:
//   - System-prompt injection. Pass `system` (string) OR `projectId`; when a
//     projectId is given, the project's composed instructions become the system
//     prompt. This is what makes a Chat project "become" its tuned mode.
//   - Transient-error retry (429/500/529) via fetchWithRetry — half the blank-lane fix.
//   - Error events are still emitted as {"error":...}; the front-end MUST render them
//     into the lane (the other half of the blank-lane fix).
//
// Request body:
//   { provider:"claude"|"gpt", model:"<id>", messages:[...], system?:"...", projectId?:"..." }
// Returns: text/event-stream (SSE) with {"delta":"..."} chunks, then [DONE].

import { verifyToken } from "./_verify.js";
import { tokenFrom, userFromToken } from "./_session.js";
import { loadProject, composeSystem } from "./_projects.js";
import { CATALOG } from "./_catalog.js";
import { mergedCatalog } from "./_skills.js";
import { fetchWithRetry } from "./_llm.js";
import { getKeys } from "./_providers.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  const token = tokenFrom(request);
  if (!(await verifyToken(token, env.SESSION_SECRET))) {
    return sse_error("Session expired — please log in again.", 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return sse_error("Bad request body", 400);
  }
  const { provider, model, messages } = body || {};
  if (!provider || !model || !Array.isArray(messages)) {
    return sse_error("Missing provider, model, or messages", 400);
  }

  // Resolve the system prompt: an explicit `system` string wins; otherwise compose
  // from the referenced project. Failure here is non-fatal — chat still works raw.
  let system = typeof body.system === "string" ? body.system : "";
  if (!system && body.projectId) {
    try {
      const project = await loadProject(env, userFromToken(token), body.projectId);
      if (project) system = composeSystem(project, await mergedCatalog(env, userFromToken(token)));
    } catch {
      /* proceed without a system prompt */
    }
  }

  const keys = await getKeys(env, userFromToken(token));
  try {
    if (provider === "claude") {
      return await streamClaude(keys.anthropic, model, messages, system);
    } else if (provider === "gpt") {
      return await streamGPT(keys.openai, model, messages, system);
    }
    return sse_error("Unknown provider", 400);
  } catch (err) {
    return sse_error("Upstream error: " + (err.message || "unknown"), 502);
  }
}

// ---------- CLAUDE ----------
async function streamClaude(apiKey, model, messages, system) {
  if (!apiKey) return sse_error("Claude key not configured", 500);

  const payload = {
    model,
    max_tokens: 8192,
    stream: true,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (system && system.trim()) payload.system = system.trim();

  const upstream = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok) {
    const t = await upstream.text();
    return sse_error(`Claude API ${upstream.status}: ${t.slice(0, 200)}`, 502);
  }

  return transformStream(upstream.body, (evt) =>
    evt.type === "content_block_delta" && evt.delta?.text ? evt.delta.text : null
  );
}

// The client sends Anthropic-shaped content: a plain string, or an array of blocks like
// {type:"text",text} / {type:"image",source:{type:"base64",media_type,data}}.
// OpenAI wants {type:"text",text} / {type:"image_url",image_url:{url:"data:…;base64,…"}}.
function toOpenAIContent(content) {
  if (!Array.isArray(content)) return content;
  return content
    .map((b) => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "image" && b.source?.type === "base64") {
        return {
          type: "image_url",
          image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
        };
      }
      return null;
    })
    .filter(Boolean);
}

// ---------- GPT ----------
async function streamGPT(apiKey, model, messages, system) {
  if (!apiKey) return sse_error("OpenAI key not configured", 500);

  const msgs = messages.map((m) => ({ role: m.role, content: toOpenAIContent(m.content) }));
  if (system && system.trim()) msgs.unshift({ role: "system", content: system.trim() });

  const upstream = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, messages: msgs }),
  });

  if (!upstream.ok) {
    const t = await upstream.text();
    return sse_error(`OpenAI API ${upstream.status}: ${t.slice(0, 200)}`, 502);
  }

  return transformStream(upstream.body, (evt) => evt.choices?.[0]?.delta?.content || null);
}

// ---------- SSE plumbing ----------
function transformStream(upstreamBody, pick) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstreamBody.getReader();
      let usage = { input: 0, output: 0 };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;
            let evt;
            try {
              evt = JSON.parse(data);
            } catch {
              continue;
            }
            // Token usage: Anthropic (message_start / message_delta) + OpenAI (final usage chunk).
            if (evt.type === "message_start" && evt.message && evt.message.usage) usage.input = evt.message.usage.input_tokens || usage.input;
            if (evt.type === "message_delta" && evt.usage && evt.usage.output_tokens != null) usage.output = evt.usage.output_tokens;
            if (evt.usage && evt.usage.prompt_tokens != null) { usage.input = evt.usage.prompt_tokens; usage.output = evt.usage.completion_tokens || 0; }
            // Surface provider IN-STREAM error events. Anthropic (and OpenAI) can return
            // HTTP 200 and then fail mid-stream with {type:"error"} / {error:...} — e.g.
            // "overloaded", "rate_limit", or "credit balance too low". v1 dropped these,
            // which is the real root of the blank Claude lane. Now we forward the reason.
            if (evt.type === "error" || evt.error) {
              const emsg =
                evt.error?.message || evt.error?.type || evt.message || "upstream error";
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: emsg })}\n\n`));
              continue;
            }
            const text = pick(evt);
            if (text) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: text })}\n\n`));
            }
          }
        }
        if (usage.input || usage.output) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ usage })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: err.message || "stream error" })}\n\n`)
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/* ALWAYS HTTP 200. This is GOTCHA #6 and it bit us here for real: Cloudflare Pages replaces
   the body of a 4xx/5xx response with its own branded HTML error page, so every reason this
   function ever gave — "Claude API 400: prompt is too long", "key not configured",
   "Upstream error" — was thrown away before the browser could read it. The client parsed
   zero SSE lines and rendered a blank lane with "(no output returned)".
   The failure IS the payload here, so it has to travel in a 200. `x-plx-error` carries the
   reason in a header too, for anyone reading the network tab. */
function sse_error(msg, status) {
  return new Response(`data: ${JSON.stringify({ error: msg, status })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "x-plx-error": String(status || ""),
    },
  });
}
