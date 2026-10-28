// Scene: real 3D in a reply (Zeron's ui.scene), drawn by three.js through
// sceneWorld.ts on a transparent canvas laid on the chat. The reader drags to
// orbit, pinches or ctrl/⌘ + wheels to zoom, and double-clicks to go back to
// the scene's own camera; touch keeps vertical swipes for scrolling the
// thread. The canvas holds a WebGL context only while gpu.ts grants one
// (near the viewport, within the page's budget); otherwise the last frame
// stands in as an image of the same size. When `objects` is a function it is
// re-read every frame (core/scene.ts readScene), and only while on screen.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { readCamera, readScene, type SceneObject } from "../../core/scene";
import { isFunctionValue } from "../../core/types";
import { useUiRuntime } from "../runtime";
import { useDarkTheme } from "../theme";
import { finiteNumber, type Props } from "../values";
import { TOOLTIP } from "./chartKit";
import { ErrorLine } from "./display";
import { keepSnapshot, resolveColor, snapshot, useFrameLoop, useGpuSlot } from "./gpu";
import { MAX_PITCH, MAX_ZOOM, MIN_ZOOM, type Orbit } from "./sceneMath";
import { SceneWorld, type Hint, type LabelSize } from "./sceneWorld";
import { NO_BB_SWIPE } from "./viewer";

const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 720;
/** Radians of orbit per pixel dragged. */
const DRAG_SPEED = 0.01;
/** Zoom factor per wheel pixel (ctrl/⌘ + wheel, and trackpad pinches, which arrive as that). */
const WHEEL_ZOOM = 0.005;
/** Zeron's edge fade: the outer 15% of the shorter side fades out, so geometry never ends at a hard frame. */
const EDGE_FADE = 0.15;
/** Device pixels per CSS pixel, at most: past 2 the cost outgrows what anyone sees. */
const MAX_PIXEL_RATIO = 2;
/** Errors shown under the scene at most. */
const MAX_ERRORS = 4;

const LABEL = "pointer-events-none absolute left-0 top-0 whitespace-nowrap font-sans leading-none";
/** Label sizes in BB's type scale (body is the reply's text-sm). */
const LABEL_CLASS: Record<LabelSize, string> = {
  xs: `${LABEL} text-[11px]`,
  sm: `${LABEL} text-xs`,
  body: `${LABEL} text-sm`,
  lg: `${LABEL} text-base font-medium`,
};

export function Scene({ props }: { props: Props }) {
  const { loadAsset, blockKey } = useUiRuntime();
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, finiteNumber(props.height) ?? DEFAULT_HEIGHT));
  const orbitable = props.orbit !== false;
  const spin = finiteNumber(props.spin) ?? 0;
  const objects = props.objects ?? null;
  const animated = typeof props.animate === "boolean" ? props.animate : isFunctionValue(objects);
  const { camera } = useMemo(() => readCamera(props.camera), [props.camera]);
  // A still scene is read once per evaluation; an animated one every frame.
  const still = useMemo(() => (animated ? null : readScene(objects, 0)), [objects, animated]);

  const container = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const { active, visible } = useGpuSlot(container);
  const dark = useDarkTheme();
  const snapshotKey = `${blockKey ?? "gallery"}|scene|${useId()}`;
  const [snap, setSnap] = useState(() => snapshot(snapshotKey));
  const [world, setWorld] = useState<SceneWorld | null>(null);
  /** Bumped when the browser restores a lost context: a fresh canvas and world. */
  const [generation, setGeneration] = useState(0);
  const [lost, setLost] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const [sceneErrors, setSceneErrors] = useState<readonly string[]>([]);
  const [assetErrors, setAssetErrors] = useState<readonly string[]>([]);
  const [hint, setHint] = useState<Hint | null>(null);
  const [dragging, setDragging] = useState(false);

  const orbit = useRef<Orbit>({ ...camera });
  /** Seconds the scene has animated (paused while off screen, so it resumes where it was). */
  const clock = useRef(0);
  /** The last objects read without errors: an error keeps showing them. */
  const lastGood = useRef<readonly SceneObject[] | null>(null);
  const pending = useRef(0);
  /** The world for callbacks that outlive a render (the next-frame draw). */
  const current = useRef<SceneWorld | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);

  /** Draws once on the next frame (a still scene draws only when something changed). */
  const draw = useCallback(() => {
    if (pending.current !== 0) return;
    pending.current = requestAnimationFrame(() => {
      pending.current = 0;
      current.current?.render(orbit.current);
    });
  }, []);

  const show = useCallback((target: SceneWorld, read: { objects: SceneObject[]; errors: string[] }) => {
    // Kept when the lines are the same, so a per-frame read doesn't re-render.
    setSceneErrors((previous) =>
      previous.length === read.errors.length && previous.every((line, index) => line === read.errors[index]) ? previous : read.errors,
    );
    if (read.errors.length === 0) lastGood.current = read.objects;
    target.setObjects(lastGood.current ?? read.objects);
  }, []);

  // The world lives while the slot is granted; dropping it keeps the last frame as an image first.
  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!active || canvas === null || overlay === null) return;
    let created: SceneWorld;
    try {
      created = new SceneWorld({
        canvas,
        overlay,
        labelClass: LABEL_CLASS,
        loadAsset,
        onChange: () => created.render(orbit.current),
        onAssetErrors: (errors) => setAssetErrors(errors),
        onContextLost: () => setLost(true),
        onContextRestored: () => {
          setLost(false);
          setGeneration((value) => value + 1);
        },
      });
    } catch {
      setUnavailable(true);
      return;
    }
    setUnavailable(false);
    setAssetErrors([]);
    setWorld(created);
    current.current = created;
    return () => {
      current.current = null;
      setWorld(null);
      setHint(null);
      if (!created.contextLost) {
        created.render(orbit.current);
        keepSnapshot(snapshotKey, canvas);
        setSnap(snapshot(snapshotKey));
      }
      created.dispose();
    };
  }, [active, generation, loadAsset, snapshotKey]);

  useEffect(() => () => cancelAnimationFrame(pending.current), []);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Resizing clears the canvas, so draw at once rather than next frame.
  useEffect(() => {
    if (world === null || width === null) return;
    world.setSize(width, height, Math.min(devicePixelRatio, MAX_PIXEL_RATIO));
    world.render(orbit.current);
  }, [world, width, height]);

  useEffect(() => {
    const element = container.current;
    if (world === null || element === null) return;
    world.setColors((color) => resolveColor(element, color));
    draw();
  }, [world, dark, draw]);

  useEffect(() => {
    if (world === null) return;
    show(world, still ?? readScene(objects, clock.current));
    draw();
  }, [world, still, objects, show, draw]);

  // The scene's own camera; a new one (state bound to it changed) replaces where the reader dragged.
  useEffect(() => {
    orbit.current = { yaw: camera.yaw, pitch: camera.pitch, zoom: camera.zoom };
    draw();
  }, [camera.yaw, camera.pitch, camera.zoom, draw]);

  useFrameLoop(world !== null && visible && !lost && (animated || spin !== 0), (_t, dt) => {
    if (world === null) return;
    clock.current += dt;
    if (animated) show(world, readScene(objects, clock.current));
    orbit.current.yaw += spin * dt;
    world.render(orbit.current);
  });

  const zoomBy = useCallback(
    (factor: number) => {
      orbit.current.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, orbit.current.zoom * factor));
      draw();
    },
    [draw],
  );

  // ctrl/⌘ + wheel (and trackpad pinch, which arrives as ctrl + wheel) zooms; a plain wheel scrolls the page.
  useEffect(() => {
    const element = container.current;
    if (element === null || !orbitable) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(Math.exp(-event.deltaY * WHEEL_ZOOM));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [orbitable, zoomBy]);

  const local = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!orbitable || world === null || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, local(event));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
    }
    setDragging(true);
    setHint(null);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const at = local(event);
    const previous = pointers.current.get(event.pointerId);
    if (previous === undefined) {
      if (world === null || event.pointerType !== "mouse") return;
      const next = world.hintAt(at.x, at.y);
      setHint((current) => (current?.text === next?.text && current?.x === next?.x && current?.y === next?.y ? current : next));
      return;
    }
    pointers.current.set(event.pointerId, at);
    if (pointers.current.size === 1) {
      const { yaw, pitch, zoom } = orbit.current;
      orbit.current = {
        yaw: yaw - (at.x - previous.x) * DRAG_SPEED,
        pitch: Math.min(MAX_PITCH, Math.max(-MAX_PITCH, pitch + (at.y - previous.y) * DRAG_SPEED)),
        zoom,
      };
      draw();
    } else if (pointers.current.size === 2 && pinch.current !== null) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current > 0) zoomBy(distance / pinch.current);
      pinch.current = distance;
    }
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    pinch.current = null;
    if (pointers.current.size === 0) setDragging(false);
  };

  const onDoubleClick = () => {
    if (!orbitable) return;
    orbit.current = { ...camera };
    draw();
  };

  const fade = `${Math.round(EDGE_FADE * Math.min(width ?? height, height))}px`;
  const mask = `linear-gradient(to right, transparent, #000 ${fade}, #000 calc(100% - ${fade}), transparent), linear-gradient(to bottom, transparent, #000 ${fade}, #000 calc(100% - ${fade}), transparent)`;
  const errors = [
    ...(unavailable ? ["3D needs WebGL, which this browser has turned off"] : []),
    ...sceneErrors,
    ...assetErrors,
  ].slice(0, MAX_ERRORS);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        ref={container}
        role="img"
        aria-label="3D scene"
        {...(orbitable ? NO_BB_SWIPE : {})}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={() => setHint(null)}
        onDoubleClick={onDoubleClick}
        className={cn("relative min-w-0 select-none overflow-hidden", orbitable && (dragging ? "cursor-grabbing" : "cursor-grab"))}
        // Vertical swipes still scroll the thread on touch; horizontal drags and pinches turn the scene.
        style={{ height, touchAction: orbitable ? "pan-y" : "auto" }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ maskImage: mask, WebkitMaskImage: mask, maskComposite: "intersect", WebkitMaskComposite: "source-in" }}
        >
          {snap !== null && (!active || lost || world === null) ? (
            <img src={snap} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
          ) : null}
          {active && !unavailable ? <canvas key={generation} ref={canvasRef} className={cn("absolute inset-0 block size-full", lost && "invisible")} /> : null}
        </div>
        <div ref={overlayRef} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" />
        {hint !== null ? (
          <div className={cn(TOOLTIP, "min-w-0 -translate-x-1/2 -translate-y-full whitespace-nowrap text-foreground")} style={{ left: hint.x, top: hint.y - 8 }}>
            {hint.text}
          </div>
        ) : null}
      </div>
      {errors.map((error) => (
        <ErrorLine key={error} message={error} />
      ))}
    </div>
  );
}
