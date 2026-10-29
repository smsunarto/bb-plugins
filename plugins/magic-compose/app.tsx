// Magic Compose frontend: the Magic Compose toggle in the New thread composer. The
// settings page is in settings.tsx.
import {
  type CSSProperties,
  createElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { WandSparkles as WandSparklesIcon } from "@hugeicons/core-free-icons";
import { definePluginApp, useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { registerSettings } from "./settings";
import { magicMode } from "@/lib/magic-mode";
import { findComposer } from "@/lib/composer-dom";
import { selectionFor } from "@/lib/fill";
import type { LiveFillSnapshot } from "@/lib/live-fill";
import { DEFAULT_PREFERENCES, type Preferences } from "@/lib/preferences";
import { acquireSession, releaseSession, type Session } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
} from "@/components/ui/coarse-pointer-sizing";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import "./app.css";

/** The server keeps its connection to Jev hot for a few minutes after each warm. */
const WARM_AT_MOST_EVERY_MS = 20_000;

function useMagicMode(): boolean {
  return useSyncExternalStore(magicMode.subscribe, magicMode.get, () => false);
}

type WandState = "off" | "on" | "pending" | "error";

/**
 * What the wand shows. On and off follow the toggle, as aria-pressed and the
 * tooltip do: Magic Compose waits for the preferences and a composer before it
 * acts, and the wand must not go dark meanwhile. The phase adds what it is doing.
 */
function wandState(enabled: boolean, snapshot: LiveFillSnapshot): WandState {
  if (snapshot.phase === "pending" || snapshot.phase === "error") return snapshot.phase;
  return enabled ? "on" : "off";
}

// The icon draws the stick first and then its two sparkles. They are rendered
// as separate parts here so that app.css can move each on its own.
const [WAND_STICK, ...WAND_SPARKLES] = WandSparklesIcon;
/** The tip of the wand, and where the motes that come off it fly to, in the icon's 24-unit box. */
const WAND_TIP = { x: 10, y: 11 };
const WAND_MOTES = [
  { dx: -6.5, dy: -1.5 },
  { dx: -5, dy: -5.5 },
  { dx: -1.5, dy: -7 },
];
/** Evenly spaced and equally bright, ending where it began so the sweep has no seam. */
const RAINBOW_HUES = [0, 60, 120, 180, 240, 300, 360];

/** One trip of the rainbow across the sparkles. Slow enough to be noticed only in passing. */
const RAINBOW_DRIFT = "24s";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
function subscribeToReducedMotion(listener: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

function wandPart(
  element: (typeof WandSparklesIcon)[number],
  name: string,
  props: Record<string, unknown>,
) {
  // The icon's own keys are dropped: they would collide with the motes'.
  const [tag, { key: _key, ...attributes }] = element as [string, Record<string, unknown>];
  return createElement(tag, { ...attributes, ...props, key: name });
}

/**
 * The Magic Compose toggle's icon, which is how it shows its state: a filled button
 * there would compete with send, the one filled control in that row. On, the
 * sparkles are lit with a rainbow that drifts slowly across them. `moment`
 * changes each time the wand should move, which restarts its animations:
 * `flick` turns the stick, `cast` pops the sparkles and sends motes off the tip.
 */
function MagicWand({
  state,
  moment,
  flick,
  cast,
}: {
  state: WandState;
  moment: number;
  flick: boolean;
  cast: boolean;
}) {
  const gradientId = `magic-compose-rainbow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const still = usePrefersReducedMotion();
  const lit = state === "on" || state === "pending";
  const rainbow = `url(#${gradientId})`;
  return (
    <svg
      key={moment}
      viewBox="0 0 24 24"
      fill="none"
      className={cn(
        COARSE_POINTER_ICON_SIZE_CLASS,
        "magic-compose-wand",
        state === "error" && "text-destructive",
      )}
      data-state={state}
      data-flick={flick ? "" : undefined}
      data-cast={cast ? "" : undefined}
      data-icon-root=""
      aria-hidden
    >
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="24"
          y2="12"
          spreadMethod="repeat"
        >
          {RAINBOW_HUES.map((hue) => (
            <stop key={hue} offset={hue / 360} stopColor={`oklch(0.74 0.17 ${hue})`} />
          ))}
          {/* One full period of the gradient, so the loop has no jump. */}
          {!still && (
            <animateTransform
              attributeName="gradientTransform"
              type="translate"
              from="0 0"
              to="24 12"
              dur={RAINBOW_DRIFT}
              repeatCount="indefinite"
            />
          )}
        </linearGradient>
      </defs>
      {WAND_STICK !== undefined && wandPart(WAND_STICK, "stick", { className: "stick" })}
      {WAND_SPARKLES.map((sparkle, index) =>
        wandPart(sparkle, `sparkle-${index}`, {
          className: "sparkle",
          ...(lit ? { fill: rainbow, stroke: rainbow } : {}),
        }),
      )}
      {WAND_MOTES.map((mote, index) => (
        <circle
          key={`mote-${index}`}
          className="mote"
          cx={WAND_TIP.x}
          cy={WAND_TIP.y}
          r="0.9"
          fill={lit ? rainbow : "currentColor"}
          style={{ "--dx": `${mote.dx}px`, "--dy": `${mote.dy}px` } as CSSProperties}
        />
      ))}
    </svg>
  );
}

/**
 * The preferences as last read, kept outside the button. BB rebuilds the button
 * when Magic Compose changes the project, and the new one must carry straight on, not
 * wait to read them again.
 */
let lastKnownPreferences: Preferences | null = null;

const NO_SESSION: LiveFillSnapshot = { phase: "off" };
const getNoSession = () => NO_SESSION;
const getNoCasts = () => 0;
const subscribeToNothing = () => () => {};

/**
 * The Magic Compose toggle, in the composer beside the send button. While it is on, Jev
 * is asked again as the draft changes and the composer's pickers follow. Send
 * waits until the pickers match the draft, so what runs is what was shown.
 */
function MagicToggle() {
  const enabled = useMagicMode();
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const anchor = useRef<HTMLSpanElement>(null);
  const [session, setSession] = useState<Session | null>(null);

  // BB rebuilds this button when the composer's project changes, which Magic Compose
  // itself causes. The session belongs to the composer, so it carries on.
  useLayoutEffect(() => {
    const root = anchor.current === null ? null : findComposer(anchor.current);
    if (root === null) return;
    setSession(acquireSession(root));
    return () => releaseSession(root);
  }, []);

  // What the settings page says Magic Compose should do here. Read again when the
  // window comes back, which is when it may have been changed. Magic Compose waits for
  // the first read, so that it never sets a picker it was told to leave alone.
  const [known, setKnown] = useState(lastKnownPreferences);
  useEffect(() => {
    const read = () => {
      rpc.call("preferencesGet").then(
        (result) => {
          lastKnownPreferences = result.preferences;
          setKnown(result.preferences);
        },
        () => {},
      );
    };
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [rpc]);
  const { maySet, holdSend, pace } = known ?? DEFAULT_PREFERENCES;
  const sets = `${maySet.project}${maySet.placement}${maySet.model}${maySet.effort}`;
  const setsAnything = maySet.project || maySet.placement || maySet.model;

  const scope = composer.scope;
  const projectId = scope.kind === "new-thread" ? scope.projectId : null;
  useLayoutEffect(() => {
    session?.attach({
      route: async (text) => {
        // A project Magic Compose may not set is the one to route within.
        const pinned = maySet.project ? null : projectId;
        const { decision } = await rpc.call("preview", { text, projectId: pinned });
        return selectionFor(decision, maySet);
      },
      setSelection: (selection) => composer.setSelection(selection),
    });
    // `sets` stands for `maySet`, which is a new object on every read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, rpc, composer, projectId, sets]);

  const text = composer.text;
  useEffect(() => session?.setHoldSend(holdSend), [session, holdSend]);
  useEffect(() => session?.live.setPace(pace), [session, pace]);
  useEffect(() => session?.live.setText(text), [session, text]);
  useEffect(() => {
    if (known !== null) session?.setMaySet(sets);
  }, [session, known, sets]);
  useEffect(
    () => session?.live.setEnabled(enabled && known !== null && setsAnything),
    [session, enabled, known, setsAnything],
  );

  // The first request on a cold connection takes a second or more, so the
  // server opens it, and refreshes what it knows about machines and projects,
  // before the first word is typed.
  const lastWarmAt = useRef(0);
  const warm = useCallback(() => {
    if (Date.now() - lastWarmAt.current < WARM_AT_MOST_EVERY_MS) return;
    lastWarmAt.current = Date.now();
    rpc.call("warm").catch(() => {});
  }, [rpc]);
  useEffect(() => {
    if (!enabled) return;
    warm();
    window.addEventListener("focus", warm);
    return () => window.removeEventListener("focus", warm);
  }, [enabled, warm]);

  const snapshot = useSyncExternalStore(
    session?.live.subscribe ?? subscribeToNothing,
    session?.live.getSnapshot ?? getNoSession,
  );

  // Magic Compose moving the pickers makes the wand cast, though not for moves made
  // before this button was (re)built. A click flicks it, and casts if that
  // switched Magic Compose on.
  const casts = useSyncExternalStore(
    session?.subscribeCasts ?? subscribeToNothing,
    session?.getCasts ?? getNoCasts,
  );
  const castsAtMount = useRef<number | null>(null);
  if (session !== null && castsAtMount.current === null) castsAtMount.current = casts;
  const moves = casts - (castsAtMount.current ?? casts);
  const [clicks, setClicks] = useState({ count: 0, atMoves: -1 });
  // The latest of the two is the one the wand is showing.
  const clickedLast = clicks.count > 0 && clicks.atMoves === moves;

  const state = wandState(enabled, snapshot);
  return (
    <span ref={anchor} className="contents">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
                // Pressed is drawn by the icon, not by the ghost button's fill.
                "aria-pressed:bg-transparent aria-pressed:hover:bg-state-hover",
                !enabled && "text-muted-foreground",
              )}
              aria-label="Magic Compose"
              aria-pressed={enabled}
              // On the way to switching it on.
              onPointerEnter={warm}
              onFocus={warm}
              onClick={() => {
                setClicks((current) => ({ count: current.count + 1, atMoves: moves }));
                magicMode.set(!enabled);
              }}
            >
              <MagicWand
                state={state}
                moment={moves + clicks.count}
                flick={clickedLast}
                cast={clickedLast ? enabled : moves > 0}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {snapshot.phase === "error"
              ? `Magic Compose: ${snapshot.message}`
              : enabled
                ? "Magic Compose is on: Jev picks where this runs as you type"
                : "Magic Compose: let Jev pick where this runs as you type"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "auto",
    scopes: ["new-thread"],
    actions: [{ id: "toggle", component: MagicToggle }],
  });
  registerSettings(app);
});
