// functions/api/_catalog.js — the bundled skill catalog.
//
// A "skill" is a named set of standing instructions. Adding one clones it into your
// Projects, where its `instructions` become the system prompt of that project's API calls.
// Custom skills you create live in KV and merge with this list — see _skills.js.
//
// These two are EXAMPLES, kept deliberately small. They exist so a fresh deployment has
// something to click, and so the shape of an entry is obvious without reading the code.
// Replace them with your own; nothing else depends on their contents.

export const CATALOG = [
  {
    id: "shot-list",
    name: "Shot List",
    author: "example",
    type: "video",
    subtype: null,
    status: "ready",
    note: null,
    description:
      "Turns a one-line idea into a numbered shot list with framing, camera move, duration and the reason each shot exists. Use when you know what a scene is about but not how it is covered.",
    instructions: [
      "Turn the user's idea into a shot list. Never write prose about the idea first — open with shot 1.",
      "",
      "For each shot give, on one line each:",
      "  SHOT n — framing (wide / medium / close / insert), lens feel, camera move, duration in seconds",
      "  Action: what happens, in one sentence, present tense",
      "  Why: the single reason this shot is in the cut",
      "",
      "Rules:",
      "- Six to ten shots unless the user asks for a different count.",
      "- Durations must add up to a real runtime; state the total at the end.",
      "- Vary the framing. Three medium shots in a row is a note to give, not a list to hand over.",
      "- If the idea does not support a shot you would defend, say so and give fewer shots.",
      "- No camera brands, no film stock, no mood adjectives standing in for coverage.",
    ].join("\n"),
    reference: [],
    defaultSettings: { duration: "5s", resolution: "1080p" },
  },
  {
    id: "prompt-tighten",
    name: "Prompt Tighten",
    author: "example",
    type: "image",
    subtype: null,
    status: "ready",
    note: null,
    description:
      "Rewrites a rough image prompt into one that reads as a described photograph or frame, and says what it changed. Use when a prompt is producing something close to but not what you meant.",
    instructions: [
      "Rewrite the user's image prompt. Return exactly two sections and nothing else:",
      "",
      "PROMPT",
      "The rewritten prompt, as one paragraph of plain description. Subject first, then what the",
      "subject is doing, then the setting, then the light, then the framing. No keyword lists, no",
      "weights, no trailing parameter soup.",
      "",
      "CHANGED",
      "Two to four bullets naming what you altered and why. Be specific: 'moved the light source",
      "behind the subject so the rim separates her from the background', not 'improved lighting'.",
      "",
      "Rules:",
      "- Keep every concrete thing the user asked for. You are tightening, not redirecting.",
      "- Cut words that describe quality rather than content — masterpiece, 8k, highly detailed,",
      "  award winning. They cost tokens and buy nothing.",
      "- If the prompt is already tight, say so under CHANGED and return it close to unchanged.",
      "  A rewrite for its own sake is worse than no rewrite.",
    ].join("\n"),
    reference: [],
    defaultSettings: {},
  },
];
