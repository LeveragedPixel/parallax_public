# Parallax

A self-hosted AI studio that runs entirely on Cloudflare's edge. Two models answer side by
side, image and video generation land in a gallery that remembers where they came from, and
a projects-and-skills engine keeps every job on the same rules without you retyping them.

No framework. No build step. No runtime dependencies. A deploy is a `git push`.

---

## The idea

Most AI tools give you one model and one text box. Parallax is built on a **Projects engine**
instead: a project stores a name, a type (`chat` / `image` / `video`), its own `instructions`,
optional `reference` material, and default settings. Opening a project makes the console
*become* that mode — the backend injects the project's instructions as the system prompt of
its API calls.

That single abstraction carries all three modes. A prompt-writing skill, a house style guide,
and a client's brand rules are all the same object, and attaching one to a project means every
thread and every render inside it follows those rules.

```
Project {
  id, name, type: "chat" | "image" | "video",
  instructions: string,                 // becomes the system prompt
  reference:  [{ kind, title, body }],  // glossary, style notes, examples
  settings:   { ... },                  // models, provider, duration, aspect
  createdAt, updatedAt
}
```

## What's in it

- **Dual-model chat** — Claude and GPT answer in parallel, or collaborate on one thread.
- **Image and video generation** with per-generation cost and remaining credit, into a
  gallery with folders.
- **Connected media** — send any image or video back into chat, image or video as a
  reference. A video to chat samples frames; a video to image takes the last one.
- **Skills** — named sets of standing instructions. Bundle them, write your own, attach
  them to projects.
- **Voice input** via Whisper, and audio-to-lyrics for prompt writing.
- **Studio Console** (`/console/`) — a GitHub manager that does atomic multi-file commits
  and one-click rollback from the browser.
- **A passwordless demo account** — see below.

## Try it without an account

Click **Try the demo** on the login screen. No email, no password.

Each demo login mints a *private* workspace with its own projects, gallery and skills,
which expires after 24 hours. It is not a shared sandbox — two visitors never see each
other's work.

Two things the demo deliberately cannot do, because a public instance runs on somebody's
real Cloudflare account:

- **It does not inherit the operator's API keys.** Connect your own key in Connections and
  everything works. Without one, the thinking half still runs; generation does not. An
  operator who wants to fund public generation sets `DEMO_SHARED_KEYS=on`.
- **It cannot reach the Studio Console**, which commits to a real repository. There is no
  setting to relax that one.

See [`functions/api/_demo.js`](functions/api/_demo.js) — the whole policy is one short file.

## Deploy your own

1. Fork this repo.
2. Cloudflare → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**, pick the fork.
3. Build settings: framework preset **None**, build command **blank**, output directory
   **`public`**. Functions in `/functions` are picked up automatically.
4. Create a KV namespace and bind it as **`PARALLAX_KV`** under Settings → Functions.
5. Add the environment variables from [`.env.example`](.env.example). At minimum:
   `SESSION_SECRET`, `APP_USER`, `APP_PASS`, and one provider key.
6. Deploy. The studio is at `/studio/`.

> Secrets only reach a Function on a **new** deployment. Adding one changes nothing until
> you redeploy — this catches everybody once.

## Layout

```
public/
  studio/      the console (index.html + app.js)
  console/     the GitHub manager
  themes.css   palettes
functions/api/
  _demo.js       demo identity and policy
  _projects.js   projects storage + system-prompt composition
  _providers.js  provider adapters and key resolution
  _skills.js     user skills, merged with the bundled catalog
  _catalog.js    the bundled catalog (two examples — replace them)
  chat.js        SSE dual-model streaming
  image.js  video.js  gallery.js  boards.js  …
```

Every store is keyed by username — `projects:<user>`, `gallery:<user>`, `keys:<user>` — so
multi-tenancy and the demo's isolation are the same mechanism.

## Notes from building it on Cloudflare Pages

Two that cost real time, in case they save you some:

**Pages replaces the body of any non-2xx response with its own branded HTML.** If the
browser reads a response body, that endpoint must return HTTP 200 and carry the real
outcome in its JSON. A failing model call that returned 500 showed up as a silently blank
answer lane — the symptom looked like the model, the cause was the CDN.

**Any non-2xx response body is thrown away, so errors must travel at HTTP 200.** This is
the same rule from a different angle, and it bites hardest where it matters least to the
happy path: a rate-limit message returned as `429` reaches the browser as Cloudflare's
branded HTML, `response.json()` throws, and the user is told nothing. Every endpoint whose
body the client reads returns 200 and carries the outcome in its JSON.

**Module imports resolve at bundle time, not at runtime.** A defensive
`await import("some:module")` inside a `try/catch` does not degrade gracefully if that
module is unavailable — the *build* fails and every route goes down with it. No `catch` can
save you, because nothing ran. Reach for `fetch()` to an HTTPS endpoint instead.

## Checks

```
npm run check      # node --check every function
npm test           # the demo must never reach the operator's keys;
                   # /api/login must stop a brute force without locking the operator out
```

## License

MIT — see [LICENSE](LICENSE).
