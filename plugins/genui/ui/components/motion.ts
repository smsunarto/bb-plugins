// Entrance motion in the spirit of ChatGPT's generated UI: text fades in,
// rows and grid items rise in with a short stagger, charts draw, container
// heights glide. Every entrance plays once, when its element first mounts:
// nodes keep their React keys across re-evaluations, so state changes never
// replay it. Web Animations, not CSS classes, so no stylesheet is needed and
// nothing is left applied after the animation ends. All of it holds still
// when the system asks for reduced motion or the plugin's Animations setting
// is off (reducedMotion, useMotionScope).
import { createContext, useContext, useLayoutEffect, useRef, type RefObject } from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";
import type { MOTION_SETTINGS } from "../../server";

/** Exponential ease-out: fast start, long soft landing. */
export const EASE_OUT_EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";

export interface Entrance {
  readonly keyframes: Keyframe[];
  readonly duration: number;
  readonly delay?: number;
  /** Delay by the element's place among the elements mounting in the same frame. */
  readonly stagger?: boolean;
}

/** Text and other prose. */
export const FADE: Entrance = { keyframes: [{ opacity: 0 }, { opacity: 1 }], duration: 700 };

/** New table rows, grid items and list items. */
export const RISE: Entrance = {
  keyframes: [
    { opacity: 0, transform: "translateY(6px)" },
    { opacity: 1, transform: "none" },
  ],
  duration: 420,
  stagger: true,
};

/** Charts and other drawn data. */
export const CHART_DRAW_MS = 1800;

const STAGGER_MS = 45;
/** Items after this many start together, so a long table never trickles in. */
const STAGGER_STEPS = 6;

let staggerIndex = 0;

function staggerDelay(): number {
  if (staggerIndex === 0) requestAnimationFrame(() => (staggerIndex = 0));
  return Math.min(staggerIndex++, STAGGER_STEPS) * STAGGER_MS;
}

/** Live: follows the OS setting without a reload. */
const SYSTEM_REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)");

const ANIMATIONS: keyof typeof MOTION_SETTINGS = "animations";
/**
 * The Animations setting turned off, as a block last read it. Kept in
 * localStorage too: BB answers useSettings after the first blocks of a fresh
 * page have mounted, and they would play the entrances the user turned off.
 */
const ANIMATIONS_OFF_STORAGE = "bb.genui.animationsOff";
let animationsOff = readAnimationsOff();

function readAnimationsOff(): boolean {
  try {
    return localStorage.getItem(ANIMATIONS_OFF_STORAGE) !== null;
  } catch {
    return false;
  }
}

function rememberAnimationsOff(off: boolean): void {
  if (off === animationsOff) return;
  animationsOff = off;
  try {
    if (off) localStorage.setItem(ANIMATIONS_OFF_STORAGE, "1");
    else localStorage.removeItem(ANIMATIONS_OFF_STORAGE);
  } catch {
    // Storage unavailable: a fresh page moves until BB answers.
  }
}

/**
 * Whether to hold still: the system asks for reduced motion, or the plugin's
 * Animations setting is off. Read at the moment of moving, so both apply
 * without a reload.
 */
export function reducedMotion(): boolean {
  return animationsOff || SYSTEM_REDUCED_MOTION.matches;
}

/**
 * The Animations setting turned off; the caller re-renders when it changes,
 * for motion that is already running (a 3D frame loop).
 */
export function useAnimationsOff(): boolean {
  const { values } = useSettings();
  // During render, before what mounts with the caller runs its entrances.
  if (values !== undefined) rememberAnimationsOff(values[ANIMATIONS] === false);
  return animationsOff;
}

const STILL = { "data-genui-motion": "off" } as const;
const MOVING = {} as const;

/**
 * The attributes for the outer element of what the plugin mounts (a block's
 * frame, a placeholder, a portal). With the Animations setting off that is
 * `data-genui-motion="off"`, under which app.css stops every CSS transition
 * and animation; the Web Animations here and the smooth scrolls elsewhere
 * check reducedMotion().
 */
export function useMotionScope(): { readonly "data-genui-motion"?: "off" } {
  return useAnimationsOff() ? STILL : MOVING;
}

/** Zeron's streaming fade (crates/veil): seed for the gap between appends, and its clamps. */
const STREAM_GAP_SEED_MS = 160;
const STREAM_GAP_MAX_MS = 1000;
const STREAM_FADE_MIN_MS = 120;
const STREAM_FADE_MAX_MS = 400;

/**
 * How a block's source is arriving. While it streams, what mounts only fades,
 * for three times the average gap between appends (120–400 ms): a fast
 * stream settles fast, and nothing moves, so the reply never shifts under
 * the reader. Mutated in place (never a new object) so consumers don't
 * re-render per chunk; `fadeMs` is null once the source is complete.
 */
export interface StreamCadence {
  fadeMs: number | null;
  /** Average gap between appends, ms (an EMA, 0.7 old + 0.3 new). */
  gapMs: number;
  lastAt: number | null;
}

export function newStreamCadence(): StreamCadence {
  return { fadeMs: null, gapMs: STREAM_GAP_SEED_MS, lastAt: null };
}

/** Records one append (or the end of the stream) at `now`. */
export function trackStream(cadence: StreamCadence, streaming: boolean, now: number): void {
  if (!streaming) {
    cadence.fadeMs = null;
    cadence.lastAt = null;
    return;
  }
  if (cadence.lastAt !== null) {
    cadence.gapMs = 0.7 * cadence.gapMs + 0.3 * Math.min(now - cadence.lastAt, STREAM_GAP_MAX_MS);
  }
  cadence.lastAt = now;
  cadence.fadeMs = Math.min(STREAM_FADE_MAX_MS, Math.max(STREAM_FADE_MIN_MS, cadence.gapMs * 3));
}

/**
 * Until when (a `performance.now()` time) entrances stay still in a block,
 * and the block's stream cadence. BB's timeline unmounts rows that scroll out
 * of view and remounts them on the way back; a block that already played its
 * entrance in this page sets `quietUntil` just past its remount, so
 * scrolling never replays it.
 */
export const EntranceContext = createContext<{ readonly quietUntil: number; readonly stream: StreamCadence }>({
  quietUntil: 0,
  stream: newStreamCadence(),
});

/**
 * Plays `entrance` on the returned ref's element when it mounts, and never
 * again; while the block streams, an opacity-only fade at the stream's pace.
 */
export function useEntrance<T extends Element>(entrance: Entrance): RefObject<T | null> {
  const ref = useRef<T>(null);
  const { quietUntil, stream } = useContext(EntranceContext);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || reducedMotion() || performance.now() < quietUntil) return;
    const streamed = stream.fadeMs;
    const animation =
      streamed === null
        ? element.animate(entrance.keyframes, {
            duration: entrance.duration,
            delay: (entrance.delay ?? 0) + (entrance.stagger ? staggerDelay() : 0),
            easing: EASE_OUT_EXPO,
            fill: "backwards",
          })
        : element.animate(FADE.keyframes, { duration: streamed, easing: EASE_OUT_EXPO, fill: "backwards" });
    return () => animation.cancel();
    // Mount only: a later render must not replay the entrance.
  }, []);
  return ref;
}

/** When the user last pressed a pointer or a key. */
let lastInput = Number.NEGATIVE_INFINITY;
for (const type of ["pointerdown", "keydown"] as const) {
  addEventListener(type, () => (lastInput = performance.now()), { capture: true, passive: true });
}
/** A height change this soon after an input is the user's doing. */
const INPUT_WINDOW_MS = 1000;

/** Height keyframes may end at `auto` only where keywords interpolate. */
const SMOOTH_HEIGHT = CSS.supports("interpolate-size", "allow-keywords");

/** The class the outer element of `useSmoothHeight` needs. */
export const SMOOTH_HEIGHT_CLASS = "[interpolate-size:allow-keywords]";

/**
 * Glides `outer`'s height when `inner` (its content) grows or shrinks because
 * of something the user did (opening a detail, switching a tab). Changes
 * nobody asked for (a file or image arriving, a remount while scrolling, a
 * reply streaming in) snap: a box that glides on its own keeps moving the
 * conversation under the reader for its whole duration. The animation ends at
 * `height: auto`, so the box keeps following its content afterwards.
 */
export function useSmoothHeight<O extends HTMLElement, I extends HTMLElement>(): {
  outer: RefObject<O | null>;
  inner: RefObject<I | null>;
} {
  const outer = useRef<O>(null);
  const inner = useRef<I>(null);
  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!SMOOTH_HEIGHT || box === null || content === null) return;
    let last = content.offsetHeight;
    let animation: Animation | null = null;
    const observer = new ResizeObserver(() => {
      const next = content.offsetHeight;
      const delta = next - last;
      last = next;
      if (delta === 0 || reducedMotion() || performance.now() - lastInput > INPUT_WINDOW_MS) {
        animation?.cancel();
        animation = null;
        return;
      }
      // Mid-glide the box shows the animated height; otherwise it already has the new one.
      const height = box.getBoundingClientRect().height;
      const from = animation?.playState === "running" ? height : height - delta;
      animation?.cancel();
      animation = box.animate(
        [
          { height: `${from}px`, overflow: "clip" },
          { height: "auto", overflow: "clip" },
        ],
        { duration: 420, easing: EASE_OUT_EXPO },
      );
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      animation?.cancel();
    };
  }, []);
  return { outer, inner };
}
