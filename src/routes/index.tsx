import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brain,
  Camera,
  Crosshair,
  Eye,
  Gauge,
  KeyRound,
  Maximize2,
  Minimize2,
  MonitorPlay,
  Send,
  Sliders,
  Sparkles,
  Square,
  SwitchCamera,
  Target,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type CoachUpdate = {
  game: string;
  situation: string;
  next_actions: string[];
  prep: string[];
  secrets: string[];
  memory_updates: string[];
  reply: string | null;
  urgency: "calm" | "act" | "urgent";
  skill_read: string;
  pace: "twitch" | "fast" | "steady";
};

type FeedItem = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
};

// Everything the coach can't see because the player started mid-game.
type Profile = {
  platform: string;
  progress: string;
  build: string;
  style: string;
  goals: string;
  avoid: string;
};

const EMPTY_PROFILE: Profile = {
  platform: "",
  progress: "",
  build: "",
  style: "",
  goals: "",
  avoid: "",
};

const PROFILE_FIELDS: { key: keyof Profile; label: string; placeholder: string }[] = [
  { key: "platform", label: "platform", placeholder: "PC / Xbox Series X / PS5 + controller" },
  {
    key: "progress",
    label: "where you are",
    placeholder: "Act 2, Voodoo Boys quest, level 28, ~30h in",
  },
  { key: "build", label: "build & loadout", placeholder: "netrunner, Sandevistan, smart SMG" },
  { key: "style", label: "how you play", placeholder: "stealth first, hate driving, aggressive" },
  { key: "goals", label: "goals", placeholder: "best ending, max street cred, no side junk" },
  { key: "avoid", label: "don't tell me", placeholder: "story spoilers, basics, side quests" },
];

const PROFILE_KEY = "oracle:profile";
const MEMORY_KEY = "oracle:memory";

const TICKS = [
  { label: "auto", value: 0 },
  { label: "0.6s", value: 600 },
  { label: "1s", value: 1000 },
  { label: "2s", value: 2000 },
  { label: "4s", value: 4000 },
];

const SKILLS = [
  { id: "auto", label: "auto" },
  { id: "rookie", label: "rookie" },
  { id: "solid", label: "solid" },
  { id: "veteran", label: "veteran" },
  { id: "pro", label: "pro" },
] as const;

type SkillId = (typeof SKILLS)[number]["id"];

const urgencyStyles: Record<CoachUpdate["urgency"], string> = {
  calm: "bg-secondary text-secondary-foreground",
  act: "bg-warn text-accent-foreground",
  urgent: "bg-danger text-destructive-foreground",
};

// Adaptive cadence: twitch frames are read ~2x/second, calm ones back off so nothing
// is wasted on menus or downtime.
const PACE_TICK: Record<CoachUpdate["pace"], number> = {
  twitch: 500,
  fast: 1100,
  steady: 3000,
};

// Two reads may be in the air at once so a slow answer never creates a gap; stale
// answers are dropped by sequence number.
const MAX_IN_FLIGHT = 2;


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ORACLE — Real-Time AI Gaming Coach That Watches You Play" },
      {
        name: "description",
        content:
          "ORACLE watches your screen live, adapts to your skill level, tracks your game state in memory and calls your next move — plus glitches, skips and Easter eggs, without slowing you down.",
      },
      { property: "og:title", content: "ORACLE — Real-Time AI Gaming Coach" },
      {
        property: "og:description",
        content:
          "Live screen-reading AI coach: adaptive read rate, skill-aware calls, persistent game-state memory and secret tricks on demand.",
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
  const [source, setSource] = useState<"screen" | "camera">("screen");
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [tick, setTick] = useState(0); // 0 = auto / adaptive
  const [skill, setSkill] = useState<SkillId>("auto");
  const [focus, setFocus] = useState(false);
  const [objective, setObjective] = useState("");
  const [gameHint, setGameHint] = useState("");
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<CoachUpdate | null>(null);
  const [memory, setMemory] = useState<string[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [latency, setLatency] = useState<number | null>(null);

  // Live refs so the capture loop always reads current values without restarting.
  const memoryRef = useRef<string[]>([]);
  const feedRef = useRef<FeedItem[]>([]);
  const objectiveRef = useRef("");
  const hintRef = useRef("");
  const skillRef = useRef<SkillId>("auto");
  const paceRef = useRef<CoachUpdate["pace"]>("fast");
  memoryRef.current = memory;
  feedRef.current = feed;
  objectiveRef.current = objective;
  hintRef.current = gameHint;
  skillRef.current = skill;

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
      const started = performance.now();
      try {
        const res = await fetch("/api/coach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            frame: grabFrame(),
            memory: memoryRef.current,
            objective: objectiveRef.current,
            gameHint: hintRef.current,
            skill: skillRef.current,
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
        setLatency(Math.round(performance.now() - started));
        setUpdate(json);
        if (json.pace) paceRef.current = json.pace;
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

  // Self-scheduling loop: the next capture is queued only after the last one settles, and in
  // auto mode the gap follows how fast the game is actually moving.
  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    const run = async () => {
      await consult();
      if (cancelled) return;
      const gap = tick === 0 ? PACE_TICK[paceRef.current] : tick;
      timer.current = setTimeout(run, gap);
    };
    timer.current = setTimeout(run, 400);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [watching, tick, consult]);

  const attach = async (stream: MediaStream) => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => undefined);
    }
    stream.getVideoTracks()[0]?.addEventListener("ended", () => stop());
    setWatching(true);
  };

  const start = async (
    mode: "screen" | "camera" = source,
    face: "environment" | "user" = facing,
  ) => {
    setError(null);
    try {
      const stream =
        mode === "camera"
          ? await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: { ideal: face },
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 15 },
              },
              audio: false,
            })
          : await navigator.mediaDevices.getDisplayMedia({
              video: { frameRate: 15 },
              audio: false,
            });
      await attach(stream);
    } catch {
      setError(
        mode === "camera"
          ? "Camera access was blocked. Allow camera permission, then point the rear camera at your TV so the screen fills the frame."
          : "Screen sharing was blocked or isn't available on this device. On a phone, switch to Camera and point it at your TV.",
      );
    }
  };

  const pickSource = (mode: "screen" | "camera") => {
    setSource(mode);
    if (watching) void start(mode, facing);
  };

  const flipCamera = () => {
    const next = facing === "environment" ? "user" : "environment";
    setFacing(next);
    if (watching && source === "camera") void start("camera", next);
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

  const actions = update?.next_actions?.length ? update.next_actions : ["Waiting for your screen…"];

  const callCard = (
    <div className={cn("hud-panel p-4", update?.urgency === "urgent" && "glow-signal")}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Crosshair className="size-4 text-signal" />
          <span className="hud-label">do this now</span>
        </div>
        <div className="flex items-center gap-1.5">
          {update && (
            <Badge className={cn("text-[0.65rem]", urgencyStyles[update.urgency])}>
              {update.urgency}
            </Badge>
          )}
          {thinking && <span className="live-dot size-2 rounded-full bg-signal" />}
        </div>
      </div>
      <ol className="mt-3 space-y-2">
        {actions.map((action, i) => (
          <li key={`${i}-${action}`} className="flex gap-3">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded bg-signal font-mono text-xs font-semibold text-signal-foreground">
              {i + 1}
            </span>
            <span
              className={
                i === 0
                  ? "font-display text-xl font-semibold leading-snug"
                  : "text-sm leading-snug text-muted-foreground"
              }
            >
              {action}
            </span>
          </li>
        ))}
      </ol>
      {update?.situation && (
        <p className="mt-4 border-t border-border pt-3 text-sm text-muted-foreground">
          {update.situation}
        </p>
      )}
    </div>
  );

  const askForm = (
    <form
      className="flex gap-2"
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
  );

  return (
    <main
      className={cn(
        "mx-auto w-full px-4 py-6 md:px-8",
        focus ? "max-w-2xl md:py-6" : "max-w-7xl md:py-10",
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg bg-signal glow-signal">
            <Eye className="size-5 text-signal-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-bold leading-none md:text-2xl">ORACLE</h1>
            <p className="hud-label mt-1">
              {update?.game && watching ? update.game : "live gameplay intelligence"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {watching && (
            <Badge className="gap-1.5 bg-signal text-signal-foreground">
              <span className="live-dot size-2 rounded-full bg-signal-foreground" />
              {latency ? `${(latency / 1000).toFixed(1)}s` : "watching"}
            </Badge>
          )}
          {/* Source toggle: screen share on desktop, rear camera on a phone pointed at the TV. */}
          <div
            role="group"
            aria-label="Video source"
            className="flex items-center rounded-md border border-border bg-card p-0.5"
          >
            <Button
              variant={source === "screen" ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={source === "screen"}
              onClick={() => pickSource("screen")}
            >
              <MonitorPlay className="size-4" /> Screen
            </Button>
            <Button
              variant={source === "camera" ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={source === "camera"}
              onClick={() => pickSource("camera")}
            >
              <Camera className="size-4" /> Camera
            </Button>
          </div>
          {source === "camera" && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Flip camera"
              title={facing === "environment" ? "Rear camera" : "Front camera"}
              onClick={flipCamera}
            >
              <SwitchCamera className="size-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={focus ? "Exit play mode" : "Enter play mode"}
            onClick={() => setFocus((f) => !f)}
          >
            {focus ? <Maximize2 className="size-4" /> : <Minimize2 className="size-4" />}
          </Button>
          {watching ? (
            <Button variant="secondary" onClick={stop}>
              <Square className="size-4" /> Stop
            </Button>
          ) : (
            <Button onClick={() => void start()} className="glow-signal">
              {source === "camera" ? (
                <Camera className="size-4" />
              ) : (
                <MonitorPlay className="size-4" />
              )}{" "}
              Let it watch
            </Button>
          )}
        </div>
      </header>

      {error && (
        <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
          {error}
        </p>
      )}

      {/* Play mode collapses to just the call + ask line, sized to sit beside a running game.
          The video element stays mounted either way so capture never restarts. */}
      <div className={cn("mt-6 grid gap-4", !focus && "lg:grid-cols-[1.25fr_1fr]")}>
        {/* ── The call: biggest thing on screen ─────────────────────── */}
        <section className="space-y-3">
          {callCard}
          {focus && askForm}
          {focus && (
            <p className="hud-label text-center">
              play mode —{" "}
              {tick === 0 ? `auto ${PACE_TICK[paceRef.current] / 1000}s` : `${tick / 1000}s`} reads ·{" "}
              {update?.skill_read ?? (skill === "auto" ? "reading your level" : skill)}
            </p>
          )}


          <div className={cn("hud-panel overflow-hidden", focus && "hidden")}>
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
                    {source === "camera" ? (
                      <Camera className="mx-auto size-8 text-muted-foreground" />
                    ) : (
                      <Gauge className="mx-auto size-8 text-muted-foreground" />
                    )}
                    <p className="mt-3 text-sm text-muted-foreground">
                      {source === "camera"
                        ? "Prop your phone up and point the rear camera at your TV — fill the frame with the screen and avoid glare. Works for Xbox, PlayStation or Switch."
                        : "Share your game window. ORACLE reads the frame as fast as ~1s when the action is hot, backs off when it's calm, and tunes its calls to how good you already are."}
                    </p>
                  </div>
                </div>
              )}
              {thinking && (
                <span className="hud-label absolute bottom-3 right-3 rounded bg-background/70 px-2 py-1">
                  reading frame…
                </span>
              )}
            </div>
          </div>
        </section>

        {/* ── Everything else: one tab at a time, never competing ───── */}
        <section className={cn("space-y-4", focus && "hidden")}>

            <Tabs defaultValue="talk">
              <TabsList className="w-full">
                <TabsTrigger value="talk" className="flex-1 text-xs">
                  Talk
                </TabsTrigger>
                <TabsTrigger value="secrets" className="flex-1 text-xs">
                  Secrets
                </TabsTrigger>
                <TabsTrigger value="memory" className="flex-1 text-xs">
                  Memory
                </TabsTrigger>
                <TabsTrigger value="tune" className="flex-1 text-xs">
                  Tune
                </TabsTrigger>
              </TabsList>

              <TabsContent value="talk">
                <div className="hud-panel flex h-[28rem] flex-col p-4">
                  <div className="flex items-center gap-2">
                    <Sparkles className="size-4 text-signal" />
                    <span className="hud-label">talk to oracle</span>
                  </div>
                  <ScrollArea className="mt-3 flex-1 pr-3">
                    {feed.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        Ask anything: “is there a skip here?”, “stop explaining basics”, “forget the
                        main job, help me max my build”.
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
                            {f.role === "assistant" && (
                              <span className="hud-label block">oracle</span>
                            )}
                            {f.text}
                          </li>
                        ))}
                      </ul>
                    )}
                  </ScrollArea>
                  <div className="mt-3">{askForm}</div>
                </div>
              </TabsContent>

              <TabsContent value="secrets">
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
                        Nothing exploitable on screen right now. Ask for skips, hidden items or
                        Easter eggs for this area.
                      </li>
                    )}
                  </ul>
                </div>
              </TabsContent>

              <TabsContent value="memory">
                <div className="hud-panel p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Brain className="size-4 text-signal" />
                      <span className="hud-label">session memory</span>
                    </div>
                    <span className="font-mono text-xs text-muted-foreground">{memory.length}</span>
                  </div>
                  <ScrollArea className="mt-3 h-64 pr-3">
                    {memory.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        Empty. Once it watches, it remembers your build, resources, boss phases,
                        progress — and how skilled you play.
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
              </TabsContent>

              <TabsContent value="tune">
                <div className="space-y-4">
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
                      {update?.objective_status ??
                        "Steer it any time — farm loot, speedrun, no-hit, chaos."}
                    </p>
                  </div>

                  <div className="hud-panel p-4">
                    <div className="flex items-center gap-2">
                      <Sliders className="size-4 text-signal" />
                      <span className="hud-label">your level</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {SKILLS.map((s) => (
                        <Button
                          key={s.id}
                          size="sm"
                          variant={skill === s.id ? "default" : "secondary"}
                          className="h-8 font-mono text-xs"
                          onClick={() => setSkill(s.id)}
                        >
                          {s.label}
                        </Button>
                      ))}
                    </div>
                    <p className="mt-3 text-sm text-muted-foreground">
                      {skill === "auto"
                        ? update?.skill_read
                          ? `Read: ${update.skill_read}. Beginner steps are dropped as you prove yourself.`
                          : "ORACLE watches your aim, routing and menu speed and grades you itself — then stops explaining what you clearly already know."
                        : `Locked to ${skill}. Nothing below that level gets said.`}
                    </p>
                  </div>

                  <div className="hud-panel p-4">
                    <div className="flex items-center gap-2">
                      <Zap className="size-4 text-signal" />
                      <span className="hud-label">read rate</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
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
                    <p className="mt-3 text-sm text-muted-foreground">
                      {tick === 0
                        ? "Auto: ~1s during firefights and chases, easing to 4s in menus or downtime. Frames are skipped, never queued, so play never stalls."
                        : `Fixed ${tick / 1000}s reads.`}
                    </p>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
        </section>
      </div>

      <canvas ref={canvasRef} className="hidden" />

    </main>
  );
}
