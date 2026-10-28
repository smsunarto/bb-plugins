// Shared by the GPU components (Scene, Shader): which of them may hold a
// WebGL context, when they draw, and how theme tokens become colours.
//
// Browsers cap WebGL contexts per page (Chrome at 16, then the oldest is lost)
// and a long thread can hold many scenes. A component holds a context only
// while it is near the viewport and among the MAX_ACTIVE most recently seen;
// otherwise it drops the context and shows the last frame it drew as an
// image, at the same size, so the conversation never moves.
import { type RefObject, useEffect, useRef, useState } from "react";
import { ACCENT } from "../values";
import { PALETTE } from "./chartKit";
import { reducedMotion, useAnimationsOff } from "./motion";

/** GPU components holding a context at once. */
const MAX_ACTIVE = 6;
/** How far outside the viewport a component keeps (or takes) its context. */
const NEAR_MARGIN = "600px 0px";

interface Slot {
  near: boolean;
  lastSeen: number;
  setActive(active: boolean): void;
}

const slots = new Set<Slot>();

/** Grants contexts to the MAX_ACTIVE near slots seen most recently; revokes the rest. */
function rebalance(): void {
  const near = [...slots].filter((slot) => slot.near).sort((a, b) => b.lastSeen - a.lastSeen);
  const granted = new Set(near.slice(0, MAX_ACTIVE));
  for (const slot of slots) slot.setActive(granted.has(slot));
}

/**
 * Whether the component at `ref` may hold a GPU context (`active`: near the
 * viewport and within the budget) and whether it is on screen in a visible
 * page (`visible`: animate only then).
 */
export function useGpuSlot(ref: RefObject<HTMLElement | null>): { active: boolean; visible: boolean } {
  const [active, setActive] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const slot: Slot = { near: false, lastSeen: 0, setActive };
    slots.add(slot);
    const nearObserver = new IntersectionObserver(
      (entries) => {
        slot.near = entries.some((entry) => entry.isIntersecting);
        if (slot.near) slot.lastSeen = performance.now();
        rebalance();
      },
      { rootMargin: NEAR_MARGIN },
    );
    const screenObserver = new IntersectionObserver((entries) => {
      const seen = entries.some((entry) => entry.isIntersecting);
      setOnScreen(seen);
      if (seen) slot.lastSeen = performance.now();
    });
    nearObserver.observe(element);
    screenObserver.observe(element);
    const onVisibility = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      nearObserver.disconnect();
      screenObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      slots.delete(slot);
      rebalance();
    };
  }, [ref]);
  return { active, visible: onScreen && pageVisible };
}

/** The last frame each GPU block drew (a data URL), by block key: shown while it holds no context. */
const SNAPSHOTS = new Map<string, string>();
const MAX_SNAPSHOTS = 40;

export function snapshot(key: string): string | null {
  return SNAPSHOTS.get(key) ?? null;
}

/** Keeps `canvas`'s current frame as the block's snapshot. Call right after drawing, before dropping the context. */
export function keepSnapshot(key: string, canvas: HTMLCanvasElement): void {
  try {
    SNAPSHOTS.delete(key);
    SNAPSHOTS.set(key, canvas.toDataURL("image/png"));
    if (SNAPSHOTS.size > MAX_SNAPSHOTS) SNAPSHOTS.delete(SNAPSHOTS.keys().next().value!);
  } catch {
    // A tainted or lost canvas has no frame to keep; the placeholder stays blank.
  }
}

/**
 * Calls `frame(t, dt)` (seconds since the loop started, seconds since the
 * last frame) every animation frame while `running`; with reduced motion,
 * once per start. Turning the Animations setting off or on restarts it. The
 * latest `frame` is always the one called.
 */
export function useFrameLoop(running: boolean, frame: (t: number, dt: number) => void): void {
  const latest = useRef(frame);
  latest.current = frame;
  const animationsOff = useAnimationsOff();
  useEffect(() => {
    if (!running) return;
    const start = performance.now();
    let last = start;
    if (reducedMotion()) {
      latest.current(0, 0);
      return;
    }
    let handle = requestAnimationFrame(function tick(now) {
      latest.current((now - start) / 1000, Math.min(0.1, (now - last) / 1000));
      last = now;
      handle = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(handle);
  }, [running, animationsOff]);
}

/**
 * Theme tokens a scene or shader may name, as CSS colours. The chart series
 * are the Chart component's palette, so a 3D view and a chart beside it agree.
 */
export const COLOR_TOKENS: Readonly<Record<string, string>> = {
  accent: ACCENT,
  text: "var(--foreground)",
  muted: "var(--muted-foreground)",
  faint: "color-mix(in oklch, var(--muted-foreground) 50%, var(--background))",
  border: "var(--border)",
  good: "var(--success)",
  warn: "var(--warning)",
  bad: "var(--destructive)",
  info: ACCENT,
  chart1: PALETTE[0],
  chart2: PALETTE[1],
  chart3: PALETTE[2],
  chart4: PALETTE[3],
  chart5: PALETTE[4],
  chart6: PALETTE[5],
};

let probe: HTMLSpanElement | null = null;
let pixel: CanvasRenderingContext2D | null = null;

/**
 * A token or `#rrggbb` as sRGB components 0–1 (not linearized), resolved against
 * `element`'s styles (BB's variables, light or dark). Unknown names read as
 * the accent. Re-resolve when `useDarkTheme()` flips.
 */
export function resolveColor(element: HTMLElement, color: string): [number, number, number] {
  const css = /^#[0-9a-f]{6}$/i.test(color) ? color : (COLOR_TOKENS[color] ?? ACCENT);
  probe ??= Object.assign(document.createElement("span"), { hidden: true });
  element.append(probe);
  probe.style.color = css;
  const computed = getComputedStyle(probe).color;
  probe.remove();
  pixel ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (pixel === null) return [0.5, 0.5, 0.5];
  pixel.canvas.width = 1;
  pixel.canvas.height = 1;
  pixel.clearRect(0, 0, 1, 1);
  // The canvas reads any colour syntax (BB's are oklch and color-mix) back as sRGB.
  pixel.fillStyle = computed;
  pixel.fillRect(0, 0, 1, 1);
  const [red, green, blue] = pixel.getImageData(0, 0, 1, 1).data;
  return [red / 255, green / 255, blue / 255];
}
