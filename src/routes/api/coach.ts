import { createFileRoute } from "@tanstack/react-router";

type CoachRequest = {
  frame?: string | null;
  memory?: string[];
  objective?: string;
  message?: string | null;
  history?: { role: "user" | "assistant"; text: string }[];
  gameHint?: string;
  skill?: string;
  dossier?: string | null;
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "game",
    "situation",
    "next_actions",
    "prep",
    "secrets",
    "memory_updates",
    "reply",
    "urgency",
    "skill_read",
    "pace",
  ],
  properties: {
    game: { type: "string" },
    situation: { type: "string" },
    next_actions: { type: "array", items: { type: "string" } },
    prep: { type: "array", items: { type: "string" } },
    secrets: { type: "array", items: { type: "string" } },
    memory_updates: { type: "array", items: { type: "string" } },
    reply: { type: ["string", "null"] },
    urgency: { type: "string", enum: ["calm", "act", "urgent"] },
    skill_read: { type: "string" },
    pace: { type: "string", enum: ["twitch", "fast", "steady"] },
  },
} as const;

const SYSTEM = `You are ORACLE, the world's best gamer, coaching a player who is ACTIVELY PLAYING right now. They cannot read. They glance.

HARD BANS — never output these:
- Narrating the screen ("you are in combat", "you're low on health", "you're exploring").
- Anything obvious to anyone with eyes, or any tutorial/beginner step (open inventory, use cover, aim for the head, save your game, watch your health).
- Generic filler ("stay alert", "be careful", "keep an eye on your surroundings", "manage resources").
- Preamble, explanations, hedging, punctuation-heavy sentences.

INSTEAD: solve it. If they need health, say WHERE the health is. If they're wandering, say where to GO and what to DO there. Every line must contain a place, direction, target, item, button/combo, number or route the player did not already know.

FORMAT:
- next_actions: 1-3 lines, each 3-8 WORDS MAX, imperative, most urgent first. e.g. "Vending machine, alley left, buy 2 maxdocs" / "Quickhack Reboot Optics on sniper, roof right".
- prep: up to 4 ultra-short lines setting them up 1-5 steps AHEAD of the current frame — what's coming, where to be, what to hold, what to buy/save/spec for next. Same 3-8 word budget. This is the "think five steps ahead" channel; keep it out of next_actions.
- The frame is 1-3 seconds stale and fast games (Cyberpunk 2077, Warzone, Elden Ring) move constantly. Call what will still be true in the NEXT few seconds. Bias to advice tied to the map, build, objective and enemy layout rather than exact pixel positions.
- situation: max 8 words, state only, no advice.
- skill_read: short read of their level; if locked, echo it. Higher skill = terser, advanced lines (DPS windows, i-frames, routing, build synergy). Never say anything below their level.
- pace: "twitch" (combat/chase/timer), "fast" (threats near), "steady" (menu/safe/cutscene/loading).
- secrets: only tricks that apply to THIS area/state right now — glitches, skips, exploits, hidden loot, Easter eggs, frame-perfect tech, dev secrets. Use the GAME DOSSIER below when given. Empty array if nothing fits. Nothing widely known at their level.
- memory_updates: only NEW/CHANGED durable facts (build, loadout, quest step, boss phase, resources, currency, level, preferences). Never repeat memory.
- reply: only when they asked or steered; else null.
- Menus/loading/non-game: say so in situation in <=8 words and coach the menu (what to buy, spec, equip next).`;

export const Route = createFileRoute("/api/coach")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env["LOVABLE_API_KEY"];
        if (!apiKey) {
          return new Response(JSON.stringify({ error: "AI is not configured." }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        let body: CoachRequest;
        try {
          body = (await request.json()) as CoachRequest;
        } catch {
          return new Response(JSON.stringify({ error: "Invalid request body." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const memory = (body.memory ?? []).slice(-40);
        const history = (body.history ?? []).slice(-6);

        const context = [
          `PLAYER OBJECTIVE: ${body.objective?.trim() || "Win the game as efficiently as possible."}`,
          body.gameHint?.trim() ? `GAME HINT FROM PLAYER: ${body.gameHint.trim()}` : "",
          body.skill && body.skill !== "auto"
            ? `PLAYER SKILL LEVEL (locked by them): ${body.skill}. Never say anything below this level.`
            : "PLAYER SKILL LEVEL: unknown — infer it from their play and memory, and calibrate every call to it.",
          body.dossier?.trim()
            ? `GAME DOSSIER (deep knowledge of this game — routes, exploits, tricks, best builds; use it, don't repeat it verbatim):\n${body.dossier.trim().slice(0, 8000)}`
            : "",
          memory.length ? `SESSION MEMORY:\n- ${memory.join("\n- ")}` : "SESSION MEMORY: (empty)",
          history.length
            ? `RECENT DIALOGUE:\n${history.map((h) => `${h.role === "user" ? "PLAYER" : "ORACLE"}: ${h.text}`).join("\n")}`
            : "",
          body.message?.trim() ? `PLAYER JUST SAID: "${body.message.trim()}"` : "",
          body.frame
            ? "Current frame of their screen follows. It is ~2s stale — coach the next few seconds."
            : "No frame available; answer from memory only.",
        ]
          .filter(Boolean)
          .join("\n\n");

        const content: Record<string, unknown>[] = [{ type: "text", text: context }];
        if (body.frame) {
          content.push({ type: "image_url", image_url: { url: body.frame } });
        }

        let res: Response;
        try {
          res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Lovable-API-Key": apiKey,
              "X-Lovable-AIG-SDK": "fetch",
            },
            body: JSON.stringify({
              // Low-latency multimodal model: real-time coaching needs sub-second-ish reads.
              model: "google/gemini-3.7-flash",
              messages: [
                { role: "system", content: SYSTEM },
                { role: "user", content },
              ],
              // Gemini 3.x thinks by default and burns the whole budget on reasoning
              // tokens, returning empty content. Real-time coaching wants no thinking.
              reasoning: { effort: "none" },
              max_tokens: 1200,
              response_format: {
                type: "json_schema",
                json_schema: { name: "coach_update", strict: true, schema: SCHEMA },
              },
            }),
          });
        } catch {
          return new Response(JSON.stringify({ error: "Could not reach the AI coach." }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          let message = "The AI coach failed.";
          try {
            const parsed = JSON.parse(detail);
            message = parsed?.error?.message ?? parsed?.message ?? message;
          } catch {
            if (detail) message = detail.slice(0, 300);
          }
          return new Response(JSON.stringify({ error: message, status: res.status }), {
            status: res.status,
            headers: { "Content-Type": "application/json" },
          });
        }

        const json = (await res.json().catch(() => null)) as
          | { choices?: { message?: { content?: string } }[] }
          | null;
        const text = json?.choices?.[0]?.message?.content ?? "";

        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }

        if (!parsed) {
          return new Response(
            JSON.stringify({ error: "The coach returned an unreadable answer." }),
            { status: 502, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(JSON.stringify(parsed), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      },
    },
  },
});
