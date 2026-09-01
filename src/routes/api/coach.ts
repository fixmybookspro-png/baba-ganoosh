import { createFileRoute } from "@tanstack/react-router";

/**
 * SEE / THINK / SPEAK coach.
 *
 * see   → raw observations from the frame + a confidence score
 * think → game state, prediction of what's next, stuck detection
 * speak → whether anything is worth interrupting the player for, and the 3-8 word call
 *
 * The model also decides the next scan gap (scan_ms) from the state it just read, so
 * safe/menu/travel moments cost almost nothing and combat/puzzles/decisions go fast.
 */
type PlayerState = {
  mission?: string;
  stage?: string;
  progress?: string;
  build?: string;
  choices?: string;
  problems?: string;
  next_expected?: string;
};

type CoachRequest = {
  frame?: string | null;
  memory?: string[];
  objective?: string;
  message?: string | null;
  history?: { role: "user" | "assistant"; text: string }[];
  gameHint?: string;
  skill?: string;
  dossier?: string | null;
  state?: PlayerState | null;
  lastInstruction?: string | null;
  repeats?: number;
  failed?: string[];
  worked?: string[];
  sessionSummary?: string | null;
  wantsVideo?: boolean;
  profile?: {
    platform?: string;
    progress?: string;
    build?: string;
    style?: string;
    goals?: string;
    avoid?: string;
  } | null;
};

const str = { type: "string" } as const;
const strList = { type: "array", items: { type: "string" } } as const;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["game", "see", "think", "speak", "prep", "secrets", "memory_updates", "reply", "skill_read", "pace", "scan_ms", "video"],
  properties: {
    game: str,
    see: {
      type: "object",
      additionalProperties: false,
      required: ["situation", "observations", "confidence", "change"],
      properties: {
        situation: str,
        observations: strList,
        confidence: { type: "number" },
        change: str,
      },
    },
    think: {
      type: "object",
      additionalProperties: false,
      required: ["state", "prediction", "stuck", "strategy_shift"],
      properties: {
        state: {
          type: "object",
          additionalProperties: false,
          required: ["mission", "stage", "progress", "build", "choices", "problems", "next_expected"],
          properties: {
            mission: str,
            stage: str,
            progress: str,
            build: str,
            choices: str,
            problems: str,
            next_expected: str,
          },
        },
        prediction: str,
        stuck: { type: "boolean" },
        strategy_shift: str,
      },
    },
    speak: {
      type: "object",
      additionalProperties: false,
      required: ["actions", "importance", "urgency", "interrupt"],
      properties: {
        actions: strList,
        importance: { type: "number" },
        urgency: { type: "string", enum: ["calm", "act", "urgent"] },
        interrupt: { type: "boolean" },
      },
    },
    prep: strList,
    secrets: strList,
    memory_updates: strList,
    reply: { type: ["string", "null"] },
    skill_read: str,
    pace: { type: "string", enum: ["twitch", "fast", "steady"] },
    scan_ms: { type: "number" },
    video: {
      type: "object",
      additionalProperties: false,
      required: ["url", "start_seconds", "label"],
      properties: {
        url: { type: ["string", "null"] },
        start_seconds: { type: "number" },
        label: str,
      },
    },
  },
} as const;

const SYSTEM = `You are ORACLE, an expert friend watching someone play RIGHT NOW. They are holding a controller. They glance, they do not read.

Work in three separate stages and fill each part of the JSON:

SEE — what is literally on the frame. observations = short factual notes. confidence 0-1 (low if the frame is blurry, a photo of a TV, a menu, dark, or you are unsure of the game). change = what changed vs the last read, or "same".

THINK — interpret with game knowledge + the player's history and memory. Keep state fields short (a few words each). prediction = the most likely next threat/objective/puzzle/loot/decision. stuck = true only if the player has clearly failed the same thing repeatedly. strategy_shift = a DIFFERENT approach when stuck (never the same advice reworded).

SPEAK — decide if it is worth saying anything at all.
- importance 0-100. Silence is the default: if nothing changed, nothing is missable, and no danger or decision is imminent, return actions: [] with importance under 30 and interrupt false.
- interrupt true ONLY for immediate danger, a missable item/event, a major choice, or a hard timing window.
- If confidence < 0.4, stay quiet (empty actions) unless there is obvious danger.
- actions: 1-3 lines, 3-8 WORDS MAX each, imperative, concrete. Urgent = ultra short: "Heal now." "Cover left." "Wait." "Ladder behind you."
- NEVER repeat the LAST INSTRUCTION if it is still pending or already worked. If it failed, replace it with strategy_shift-style, more specific help (exact button, timing, position, alternate route).

HARD BANS: narrating the screen, anything obvious to anyone with eyes, tutorial/beginner steps, generic filler ("stay alert", "manage resources"), preamble, hedging.

prep: up to 4 lines, 3-8 words, setting them up for what is coming (from prediction).
secrets: only tricks that apply to THIS spot right now (glitches, skips, hidden loot, Easter eggs). Empty if none.
memory_updates: only NEW durable facts. Never repeat existing memory.
reply: only when they asked or steered; else null.
skill_read: short read of their level; echo it if locked. Never say anything below their level.
pace: "twitch" (combat/chase/timer), "fast" (threats near), "steady" (menu/safe/cutscene/travel).
scan_ms: how many ms until you should look again. 400-800 in combat, boss fights, puzzles with timing or missable events; 1500-3000 when exploring safe areas; 4000-10000 in menus, cutscenes, loading, fast travel, shops, safe hubs. Be efficient — do not ask for fast scans without reason.
video: only when the player asked to be SHOWN something and you know a real walkthrough video for this exact step — a real, existing YouTube URL and a start timestamp in seconds. Otherwise url null, start_seconds 0, label "". Never invent a URL.`;

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

        const memory = (body.memory ?? []).slice(-30);
        const history = (body.history ?? []).slice(-6);

        const p = body.profile ?? {};
        const profileLines = [
          p.platform?.trim() ? `Platform/controls: ${p.platform.trim()}` : "",
          p.progress?.trim() ? `Progress when they joined: ${p.progress.trim()}` : "",
          p.build?.trim() ? `Build/loadout: ${p.build.trim()}` : "",
          p.style?.trim() ? `Playstyle: ${p.style.trim()}` : "",
          p.goals?.trim() ? `Goals: ${p.goals.trim()}` : "",
          p.avoid?.trim() ? `NEVER mention: ${p.avoid.trim()}` : "",
        ].filter(Boolean);

        const s = body.state ?? {};
        const stateLines = Object.entries(s)
          .filter(([, v]) => typeof v === "string" && v.trim())
          .map(([k, v]) => `${k}: ${(v as string).trim()}`);

        const context = [
          `PLAYER OBJECTIVE: ${body.objective?.trim() || "Win the game as efficiently as possible."}`,
          profileLines.length
            ? `PLAYER CARD (they started mid-game; treat as ground truth, never re-ask it):\n- ${profileLines.join("\n- ")}`
            : "",
          stateLines.length ? `TRACKED GAME STATE:\n- ${stateLines.join("\n- ")}` : "",
          body.sessionSummary?.trim()
            ? `LAST SESSION SUMMARY:\n${body.sessionSummary.trim().slice(0, 1500)}`
            : "",
          body.lastInstruction?.trim()
            ? `LAST INSTRUCTION YOU GAVE: "${body.lastInstruction.trim()}" (repeated ${body.repeats ?? 0}x). Do not say it again in any wording.`
            : "",
          body.failed?.length ? `FAILED ATTEMPTS (change tactics):\n- ${body.failed.slice(-6).join("\n- ")}` : "",
          body.worked?.length ? `WHAT WORKED:\n- ${body.worked.slice(-6).join("\n- ")}` : "",
          body.gameHint?.trim() ? `GAME HINT FROM PLAYER: ${body.gameHint.trim()}` : "",
          body.skill && body.skill !== "auto"
            ? `PLAYER SKILL LEVEL (locked by them): ${body.skill}. Never say anything below this level.`
            : "PLAYER SKILL LEVEL: unknown — infer it and calibrate every call to it.",
          body.dossier?.trim()
            ? `GAME KNOWLEDGE (routes, exploits, tricks, boss windows, missable events — use it, don't repeat it verbatim):\n${body.dossier.trim().slice(0, 8000)}`
            : "",
          memory.length ? `SESSION MEMORY:\n- ${memory.join("\n- ")}` : "SESSION MEMORY: (empty)",
          history.length
            ? `RECENT DIALOGUE:\n${history.map((h) => `${h.role === "user" ? "PLAYER" : "ORACLE"}: ${h.text}`).join("\n")}`
            : "",
          body.message?.trim() ? `PLAYER JUST SAID: "${body.message.trim()}"` : "",
          body.wantsVideo
            ? "THEY ASKED TO BE SHOWN: return a real walkthrough video URL + timestamp for this exact step if one exists."
            : "",
          body.frame
            ? "Current frame of their screen follows. It is ~1-2s stale — call what will be true in the next few seconds."
            : "No frame available; answer from state and memory only.",
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
