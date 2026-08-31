import { createFileRoute } from "@tanstack/react-router";

/**
 * One deep "everything I know about this game" brief, fetched once when ORACLE
 * identifies the game, then carried on every fast frame read so the real-time
 * coach can be terse while still knowing routes, exploits and tricks.
 */
type DossierRequest = { game?: string; skill?: string; objective?: string };

const SYSTEM = `You are the deepest game-knowledge archive alive. Produce a dense reference brief a live coach will read while the player plays.

Write compact bullet lines, no prose, no headings longer than one word, max ~1200 words. Cover, for THIS game:
- Progression spine: main quest/level order, gates, points of no return, missable content.
- Best-value routes and speedrun lines, skips, sequence breaks.
- Glitches, exploits, duplication, infinite money/XP, item farms — with how to trigger them.
- Easter eggs, secret areas, hidden weapons/items and exactly where they are.
- Where to reliably get healing, ammo, currency, upgrades, fast travel.
- Strongest builds/loadouts and the earliest point each is viable.
- Boss/encounter tells, i-frames, DPS windows, resistances.
- Common traps that waste time or lock out rewards.
Assume the reader is skilled: no controls, no tutorials, no basics.`;

export const Route = createFileRoute("/api/dossier")({
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

        let body: DossierRequest;
        try {
          body = (await request.json()) as DossierRequest;
        } catch {
          return new Response(JSON.stringify({ error: "Invalid request body." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const game = body.game?.trim();
        if (!game) {
          return new Response(JSON.stringify({ error: "No game given." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const prompt = [
          `GAME: ${game}`,
          body.objective?.trim() ? `PLAYER OBJECTIVE: ${body.objective.trim()}` : "",
          body.skill && body.skill !== "auto" ? `PLAYER SKILL: ${body.skill}` : "",
          "Write the brief now.",
        ]
          .filter(Boolean)
          .join("\n");

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
              model: "google/gemini-3.7-flash",
              messages: [
                { role: "system", content: SYSTEM },
                { role: "user", content: prompt },
              ],
              reasoning: { effort: "none" },
              max_tokens: 2400,
            }),
          });
        } catch {
          return new Response(JSON.stringify({ error: "Could not reach the archive." }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          return new Response(
            JSON.stringify({ error: detail.slice(0, 300) || "Archive lookup failed." }),
            { status: res.status, headers: { "Content-Type": "application/json" } },
          );
        }

        const json = (await res.json().catch(() => null)) as
          | { choices?: { message?: { content?: string } }[] }
          | null;
        const dossier = json?.choices?.[0]?.message?.content?.trim() ?? "";

        return new Response(JSON.stringify({ game, dossier }), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      },
    },
  },
});
