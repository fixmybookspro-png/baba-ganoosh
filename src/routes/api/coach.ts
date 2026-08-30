import { createFileRoute } from "@tanstack/react-router";

type CoachRequest = {
  frame?: string | null;
  memory?: string[];
  objective?: string;
  message?: string | null;
  history?: { role: "user" | "assistant"; text: string }[];
  gameHint?: string;
  skill?: string;
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "game",
    "situation",
    "objective_status",
    "next_actions",
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
    objective_status: { type: "string" },
    next_actions: { type: "array", items: { type: "string" } },
    secrets: { type: "array", items: { type: "string" } },
    memory_updates: { type: "array", items: { type: "string" } },
    reply: { type: ["string", "null"] },
    urgency: { type: "string", enum: ["calm", "act", "urgent"] },
    skill_read: { type: "string" },
    pace: { type: "string", enum: ["twitch", "fast", "steady"] },
  },
} as const;

const SYSTEM = `You are ORACLE, the world's smartest gamer and live coach. You watch a single screenshot from the player's live gameplay and coach them in real time.

Rules:
- Identify the game, then read the HUD precisely: health, ammo, resources, timers, score, lives, quest text, minimap, menus, enemies.
- The frame may already be 1-3 seconds old and dense games (Cyberpunk 2077, Elden Ring, Warzone) move fast. Never narrate what is already happening; call what the player should do in the NEXT few seconds, and prefer advice that stays true even if the scene shifted slightly.
- Be extremely concise. next_actions = 1-3 imperative micro-instructions (e.g. "Strafe right, reload behind the crate"). No fluff, no preamble.
- SKILL CALIBRATION: never state anything a player at their level already knows. Drop tutorial/beginner steps (basic controls, "open your inventory", "aim for the head", "use cover", generic difficulty warnings) unless their play clearly shows they need it. Higher skill = terser, more advanced, assume mechanics knowledge, talk in optimal lines, DPS windows, i-frames, routing and build synergies. If nothing non-obvious is worth saying, return ONE high-value call rather than padding to three.
- skill_read = your short read of the player's level based on their play and memory (e.g. "veteran — clean movement, efficient looting"). If the player locked a level, respect it exactly and echo it.
- pace = how fast this screen is changing, so the app can time its next look: "twitch" (combat, chase, boss, timer), "fast" (exploring with threats near), "steady" (menu, safe zone, cutscene, loading).
- secrets = only when genuinely relevant to what is on screen right now: known glitches, speedrun tricks, exploits, hidden items, Easter eggs, skips, frame-perfect techniques, dev secrets for this exact area/level. Empty array if nothing applies. Skip anything widely known to a player at their level.
- memory_updates = short durable facts worth remembering across the session (build, loadout, objective progress, boss phase learned, resources, skill evidence, player's stated preferences). Only NEW or CHANGED facts. Never repeat existing memory.
- objective_status = one line on progress toward the player's stated objective.
- reply = a direct answer only when the player asked something or steered the plan; otherwise null.
- Respect the player's steering objective over "win the game" if they set one.
- urgency: "urgent" if they are about to die / lose / miss a window.
- If the screen is a menu, loading, or non-game content, say so plainly in situation and coach accordingly.`;


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
        const history = (body.history ?? []).slice(-8);

        const context = [
          `PLAYER OBJECTIVE: ${body.objective?.trim() || "Win the game as efficiently as possible."}`,
          body.gameHint?.trim() ? `GAME HINT FROM PLAYER: ${body.gameHint.trim()}` : "",
          body.skill && body.skill !== "auto"
            ? `PLAYER SKILL LEVEL (locked by them): ${body.skill}. Never say anything below this level.`
            : "PLAYER SKILL LEVEL: unknown — infer it from their play and memory, and calibrate every call to it.",

          memory.length ? `SESSION MEMORY:\n- ${memory.join("\n- ")}` : "SESSION MEMORY: (empty)",
          history.length
            ? `RECENT DIALOGUE:\n${history.map((h) => `${h.role === "user" ? "PLAYER" : "ORACLE"}: ${h.text}`).join("\n")}`
            : "",
          body.message?.trim() ? `PLAYER JUST SAID: "${body.message.trim()}"` : "",
          body.frame
            ? "Here is the current frame of their screen."
            : "No frame available; answer from memory only.",
        ]
          .filter(Boolean)
          .join("\n\n");

        const content: Record<string, unknown>[] = [{ type: "input_text", text: context }];
        if (body.frame) {
          content.push({ type: "input_image", image_url: body.frame, detail: "low" });
        }

        let res: Response;
        try {
          res = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Lovable-API-Key": apiKey,
              "X-Lovable-AIG-SDK": "fetch",
            },
            body: JSON.stringify({
              model: "openai/gpt-5.6-luna",
              stream: true,
              store: false,
              service_tier: "priority",
              instructions: SYSTEM,
              input: [{ role: "user", content }],
              reasoning: { effort: "low" },
              text: {
                format: {
                  type: "json_schema",
                  name: "coach_update",
                  strict: true,
                  schema: SCHEMA,
                },
              },
            }),
          });
        } catch {
          return new Response(JSON.stringify({ error: "Could not reach the AI coach." }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (!res.ok || !res.body) {
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

        // Read the SSE stream and accumulate the output text (streaming is required
        // on /v1/responses; nothing here renders progressively).
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let text = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const evt = JSON.parse(payload);
              if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
                text += evt.delta;
              } else if (evt.type === "response.completed" && !text) {
                text = evt.response?.output_text ?? "";
              }
            } catch {
              // ignore keep-alives / partial frames
            }
          }
        }

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
