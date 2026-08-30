import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brain,
  Crosshair,
  Eye,
  Gauge,
  KeyRound,
  MonitorPlay,
  Send,
  Sparkles,
  Square,
  Target,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

type CoachUpdate = {
  game: string;
  situation: string;
  objective_status: string;
  next_actions: string[];
  secrets: string[];
  memory_updates: string[];
  reply: string | null;
  urgency: "calm" | "act" | "urgent";
};

type FeedItem = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
};

const TICKS = [
  { label: "2s", value: 2000 },
  { label: "4s", value: 4000 },
  { label: "8s", value: 8000 },
];

const urgencyStyles: Record<CoachUpdate["urgency"], string> = {
  calm: "bg-secondary text-secondary-foreground",
  act: "bg-warn text-accent-foreground",
  urgent: "bg-danger text-destructive-foreground",
};

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ORACLE — Real-Time AI Gaming Coach That Watches You Play" },
      {
        name: "description",
        content:
          "ORACLE watches your screen live, tracks your game state in memory, and calls your next move — plus glitches, skips, secrets and Easter eggs, without slowing you down.",
      },
      { property: "og:title", content: "ORACLE — Real-Time AI Gaming Coach" },
      {
        property: "og:description",
        content:
          "Live screen-reading AI coach: persistent game-state memory, instant next moves, and secret tricks on demand.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Oracle,
});

function Oracle() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [watching, setWatching] = useState(false);
  const [tick, setTick] = useState(4000);
  const [objective, setObjective] = useState("");
  const [gameHint, setGameHint] = useState("");
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<CoachUpdate | null>(null);
  const [memory, setMemory] = useState<string[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);

  // Live refs so the capture loop always reads current values without restarting.
  const memoryRef = useRef<string[]>([]);
  const feedRef = useRef<FeedItem[]>([]);
  const objectiveRef = useRef("");
  const hintRef = useRef("");
  memoryRef.current = memory;
  feedRef.current = feed;
  objectiveRef.current = objective;
  hintRef.current = gameHint;

  const grabFrame = useCallback((): string | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return null;
    const width = 768;
    const height = Math.round((video.videoHeight / video.videoWidth) * width);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.55);
  }, []);

  const consult = useCallback(
    async (message?: string) => {
      // Never queue up: a busy coach silently skips the tick so play never stalls.
      if (inFlight.current) return;
      inFlight.current = true;
      setThinking(true);
      try {
        const res = await fetch("/api/coach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            frame: grabFrame(),
            memory: memoryRef.current,
            objective: objectiveRef.current,
            gameHint: hintRef.current,
            message: message ?? null,
            history: feedRef.current.slice(-8).map((f) => ({ role: f.role, text: f.text })),
          }),
        });
        const json = (await res.json()) as CoachUpdate & { error?: string };
        if (!res.ok || json.error) {
          setError(json.error ?? "The coach could not answer.");
          return;
        }
        setError(null);
        setUpdate(json);
        if (json.memory_updates?.length) {
          setMemory((prev) => {
            const seen = new Set(prev.map((m) => m.toLowerCase()));
            const added = json.memory_updates.filter(
              (m) => m.trim() && !seen.has(m.trim().toLowerCase()),
            );
            return [...prev, ...added].slice(-40);
          });
        }
        if (json.reply?.trim()) {
          setFeed((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              text: json.reply!.trim(),
              at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            },
          ]);
        }
      } catch {
        setError("Lost contact with the coach. Retrying on the next tick.");
      } finally {
        inFlight.current = false;
        setThinking(false);
      }
    },
    [grabFrame],
  );

  // Self-scheduling loop: the next capture is queued only after the last one settles.
  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    const run = async () => {
      await consult();
      if (cancelled) return;
      timer.current = setTimeout(run, tick);
    };
    timer.current = setTimeout(run, 600);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [watching, tick, consult]);

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 10 },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      stream.getVideoTracks()[0]?.addEventListener("ended", () => stop());
      setWatching(true);
    } catch {
      setError(
        "Screen sharing was blocked or isn't available on this device. Use a desktop browser and pick your game window.",
      );
    }
  };

  const stop = () => {
    setWatching(false);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setFeed((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "user",
        text,
        at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      },
    ]);
    setDraft("");
    void consult(text);
  };

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-10">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-lg bg-signal glow-signal">
            <Eye className="size-6 text-signal-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-none md:text-3xl">ORACLE</h1>
            <p className="hud-label mt-1">live gameplay intelligence</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {watching && (
            <Badge className="gap-1.5 bg-signal text-signal-foreground">
              <span className="live-dot size-2 rounded-full bg-signal-foreground" /> watching
            </Badge>
          )}
          {watching ? (
            <Button variant="secondary" onClick={stop}>
              <Square className="size-4" /> Stop
            </Button>
          ) : (
            <Button onClick={start} className="glow-signal">
              <MonitorPlay className="size-4" /> Let it watch
            </Button>
          )}
        </div>
      </header>

      {error && (
        <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
          {error}
        </p>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        {/* ── Vision + call ───────────────────────────────────────────── */}
        <section className="space-y-4">
          <div className="hud-panel overflow-hidden">
            <div className="relative aspect-video bg-black/60">
              <video
                ref={videoRef}
                muted
                playsInline
                className="size-full object-contain"
                aria-label="Live gameplay being analysed"
              />
              {!watching && (
                <div className="absolute inset-0 grid place-items-center px-6 text-center">
                  <div>
                    <Gauge className="mx-auto size-8 text-muted-foreground" />
                    <p className="mt-3 text-sm text-muted-foreground">
                      Share your game window and ORACLE reads the screen every few seconds — state,
                      HUD, objectives — and calls your next move.
                    </p>
                  </div>
                </div>
              )}
              {update && (
                <div className="absolute left-3 top-3 flex items-center gap-2">
                  <Badge className={urgencyStyles[update.urgency]}>{update.urgency}</Badge>
                  <Badge variant="outline" className="bg-background/70 font-mono text-xs">
                    {update.game}
                  </Badge>
                </div>
              )}
              {thinking && (
                <span className="hud-label absolute bottom-3 right-3 rounded bg-background/70 px-2 py-1">
                  reading frame…
                </span>
              )}
            </div>
          </div>

          <div className="hud-panel p-4">
            <div className="flex items-center gap-2">
              <Crosshair className="size-4 text-signal" />
              <span className="hud-label">do this now</span>
            </div>
            <ol className="mt-3 space-y-2">
              {(update?.next_actions?.length ? update.next_actions : ["Waiting for your screen…"]).map(
                (action, i) => (
                  <li key={`${i}-${action}`} className="flex gap-3">
                    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded bg-signal font-mono text-xs font-semibold text-signal-foreground">
                      {i + 1}
                    </span>
                    <span
                      className={
                        i === 0
                          ? "font-display text-lg font-semibold leading-snug"
                          : "text-sm leading-snug text-muted-foreground"
                      }
                    >
                      {action}
                    </span>
                  </li>
                ),
              )}
            </ol>
            {update?.situation && (
              <p className="mt-4 border-t border-border pt-3 text-sm text-muted-foreground">
                {update.situation}
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="hud-panel p-4">
              <div className="flex items-center gap-2">
                <Target className="size-4 text-accent" />
                <span className="hud-label">objective</span>
              </div>
              <Input
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="Default: win the game"
                className="mt-3 font-mono text-sm"
              />
              <Input
                value={gameHint}
                onChange={(e) => setGameHint(e.target.value)}
                placeholder="Game name (optional)"
                className="mt-2 font-mono text-sm"
              />
              <p className="mt-3 text-sm text-muted-foreground">
                {update?.objective_status ?? "Steer it any time — farm loot, speedrun, no-hit, chaos."}
              </p>
            </div>

            <div className="hud-panel p-4">
              <div className="flex items-center gap-2">
                <KeyRound className="size-4 text-accent" />
                <span className="hud-label">glitches & secrets</span>
              </div>
              <ul className="mt-3 space-y-2">
                {update?.secrets?.length ? (
                  update.secrets.map((s, i) => (
                    <li key={`${i}-${s}`} className="flex gap-2 text-sm">
                      <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" />
                      <span>{s}</span>
                    </li>
                  ))
                ) : (
                  <li className="text-sm text-muted-foreground">
                    Nothing exploitable on screen right now. Ask for skips, hidden items or Easter
                    eggs for this area.
                  </li>
                )}
              </ul>
            </div>
          </div>
        </section>

        {/* ── Memory + dialogue ───────────────────────────────────────── */}
        <section className="space-y-4">
          <div className="hud-panel p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Brain className="size-4 text-signal" />
                <span className="hud-label">session memory</span>
              </div>
              <span className="font-mono text-xs text-muted-foreground">{memory.length}</span>
            </div>
            <ScrollArea className="mt-3 h-40 pr-3">
              {memory.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Empty. Once it watches, it remembers your build, resources, boss phases and
                  progress.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {[...memory].reverse().map((m, i) => (
                    <li key={`${i}-${m}`} className="font-mono text-xs leading-relaxed">
                      <span className="text-signal">›</span> {m}
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
            {memory.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 h-7 px-2 text-xs text-muted-foreground"
                onClick={() => setMemory([])}
              >
                Clear memory
              </Button>
            )}
          </div>

          <div className="hud-panel flex h-[26rem] flex-col p-4">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-signal" />
              <span className="hud-label">talk to oracle</span>
            </div>
            <ScrollArea className="mt-3 flex-1 pr-3">
              {feed.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Ask anything: “what’s in this room?”, “is there a skip here?”, “forget winning,
                  help me max my build”.
                </p>
              ) : (
                <ul className="space-y-3">
                  {feed.map((f) => (
                    <li
                      key={f.id}
                      className={
                        f.role === "user"
                          ? "ml-auto max-w-[85%] rounded-lg rounded-br-sm bg-secondary px-3 py-2 text-sm"
                          : "max-w-[90%] rounded-lg rounded-bl-sm bg-surface-2 px-3 py-2 text-sm"
                      }
                    >
                      {f.role === "assistant" && <span className="hud-label block">oracle</span>}
                      {f.text}
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Ask or steer…"
                aria-label="Ask or steer the coach"
              />
              <Button type="submit" size="icon" aria-label="Send">
                <Send className="size-4" />
              </Button>
            </form>
          </div>

          <div className="hud-panel flex items-center justify-between p-4">
            <span className="hud-label">read rate</span>
            <div className="flex gap-1.5">
              {TICKS.map((t) => (
                <Button
                  key={t.value}
                  size="sm"
                  variant={tick === t.value ? "default" : "secondary"}
                  className="h-8 font-mono text-xs"
                  onClick={() => setTick(t.value)}
                >
                  {t.label}
                </Button>
              ))}
            </div>
          </div>
        </section>
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </main>
  );
}
