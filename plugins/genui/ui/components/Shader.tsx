// Shader: the agent's Shadertoy-style GLSL on the GPU, sitting on the chat
// (no box) by its blend mode. shaderGl.ts does the WebGL; this file holds
// the GPU slot, the clock, the pointer (iMouse and the orbit camera), the
// inputs bound to state, the textures, and the errors.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { MAX_TEXTURES } from "../../core/glsl";
import { shaderInputNames, shaderPasses } from "../../core/shader-args";
import { useUiRuntime, type UiRuntime } from "../runtime";
import { finiteNumber, isBinding, isObject, list, text, type Props } from "../values";
import { ErrorLine } from "./display";
import { keepSnapshot, snapshot, useFrameLoop, useGpuSlot } from "./gpu";
import { ShaderGl, type Blend, type ShaderFrame } from "./shaderGl";
import { NO_BB_SWIPE } from "./viewer";

const DEFAULT_HEIGHT = 320;
/** Device pixels per CSS pixel at most: a raymarcher at 3x costs 2.25x the pixels of 2x for little gain. */
const MAX_PIXEL_RATIO = 2;
/** Radians per CSS pixel of orbit drag, as in Zeron. */
const ORBIT_RATE = 0.01;

const BLENDS: Record<string, Blend> = { light: "light", alpha: "alpha", opaque: "opaque" };

/** An input's value as the float the shader reads: numbers as they are, booleans 0/1. */
function inputValue(value: unknown): number {
  const plain = isBinding(value) ? value.value : value;
  if (typeof plain === "boolean") return plain ? 1 : 0;
  return finiteNumber(plain) ?? 0;
}

/** An image path as the GPU wants it: decoded, its top row at v = 1 (Shadertoy's orientation), raw values. */
async function loadTexture(
  loadImage: NonNullable<UiRuntime["loadImage"]>,
  path: string,
): Promise<{ ok: true; image: ImageBitmap } | { ok: false; error: string }> {
  const loaded = await loadImage(path);
  if (!loaded.ok) return { ok: false, error: `textures: ${loaded.error}` };
  try {
    const blob = await (await fetch(loaded.url)).blob();
    const image = await createImageBitmap(blob, { imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" });
    return { ok: true, image };
  } catch (cause) {
    return { ok: false, error: `textures: ${path} can't be decoded (${cause instanceof Error ? cause.message : String(cause)})` };
  }
}

/** What frames read and the pointer moves, kept outside React state so the frame loop sees it at once. */
interface FrameState {
  /** CSS px. */
  width: number;
  /** Seconds the shader has animated. */
  time: number;
  frame: number;
  yaw: number;
  pitch: number;
  zoom: number;
  mouse: [number, number, number, number];
  /** Where an orbit drag started and the camera then. */
  drag: { x: number; y: number; yaw: number; pitch: number } | null;
  /** A requested frame not drawn yet. */
  pendingDraw: boolean;
}

export function Shader({ props }: { props: Props }) {
  const { loadImage, blockKey } = useUiRuntime();
  const passes = useMemo(() => shaderPasses(props), [props]);
  const inputNames = useMemo(() => shaderInputNames(props), [props]);
  // Keyed by the paths, not the list: every evaluation (a slider moving) makes a new list.
  const textureKey = list(props.textures).slice(0, MAX_TEXTURES).map(text).join("\n");
  const texturePaths = useMemo(() => (textureKey === "" ? [] : textureKey.split("\n")), [textureKey]);
  const height = Math.min(720, Math.max(120, finiteNumber(props.height) ?? DEFAULT_HEIGHT));
  const blend = BLENDS[text(props.blend)] ?? "light";
  const bloom = Math.min(3, Math.max(0, finiteNumber(props.bloom) ?? 0));
  const orbit = props.orbit === true;
  const spin = Math.min(3, Math.max(-3, finiteNumber(props.spin) ?? 0));
  const animate = props.animate !== false;
  const cameraProp: unknown = props.camera;
  const camera = isObject(cameraProp) ? cameraProp : {};
  const yaw = finiteNumber(camera.yaw) ?? 0;
  const pitch = Math.min(1.5, Math.max(-1.5, finiteNumber(camera.pitch) ?? 0));
  const zoom = Math.min(5, Math.max(0.2, finiteNumber(camera.zoom) ?? 1));
  // Buffers evolve every frame, so a shader with any keeps running.
  const moving = animate || spin !== 0 || passes.length > 1;

  // What a recompile depends on; input values and everything else update uniforms only.
  const programKey = JSON.stringify([passes, inputNames, texturePaths.length]);
  const snapshotKey = `shader:${blockKey ?? ""}:${programKey}`;

  const frameRef = useRef<HTMLDivElement>(null);
  const { active, visible } = useGpuSlot(frameRef);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [gpu, setGpu] = useState<ShaderGl | null>(null);
  /** Bumped when the browser restores a lost context: a fresh ShaderGl on the same canvas. */
  const [generation, setGeneration] = useState(0);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [shot, setShot] = useState(() => snapshot(snapshotKey));
  const [textures, setTextures] = useState<readonly (ImageBitmap | null)[]>([]);
  const [textureErrors, setTextureErrors] = useState<readonly string[]>([]);

  const state = useRef<FrameState>({
    width: 0,
    time: 0,
    frame: 0,
    yaw,
    pitch,
    zoom,
    mouse: [0, 0, -1, -1],
    drag: null,
    pendingDraw: false,
  });
  const inputsProp: unknown = props.inputs;
  const inputs = inputNames.map((name) => inputValue(isObject(inputsProp) ? inputsProp[name] : undefined));
  const live = { inputs, blend, bloom, height, spin, animate };
  const latest = useRef(live);
  latest.current = live;

  // A new camera from the spec replaces wherever the reader orbited to.
  useEffect(() => {
    Object.assign(state.current, { yaw, pitch, zoom });
  }, [yaw, pitch, zoom]);

  const gpuRef = useRef<ShaderGl | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  canvasRef.current = canvas;

  /** One frame, `delta` seconds after the last; reads only refs, so any render's copy draws the same. */
  const paint = useCallback((delta: number) => {
    const now = state.current;
    now.pendingDraw = false;
    const target = gpuRef.current;
    const element = canvasRef.current;
    if (target === null || element === null || !target.ready) return;
    const { inputs, blend, bloom, height, spin, animate } = latest.current;
    const pixelRatio = Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(now.width * pixelRatio));
    const deviceHeight = Math.max(1, Math.round(height * pixelRatio));
    if (element.width !== width || element.height !== deviceHeight) {
      element.width = width;
      element.height = deviceHeight;
    }
    // A still shader keeps the time it first showed (0); iFrame always counts.
    if (animate) now.time += delta;
    if (now.drag === null) now.yaw += spin * delta;
    const frame: ShaderFrame = {
      width,
      height: deviceHeight,
      pixelRatio,
      time: now.time,
      delta,
      frame: now.frame,
      mouse: now.mouse,
      camera: [now.yaw, now.pitch, now.zoom, 0],
      inputs,
      blend,
      bloom,
    };
    target.draw(frame);
    now.frame += 1;
  }, []);

  /**
   * One frame soon, for a change while nothing animates. When the frame loop
   * runs it draws first in the same animation frame and this one is skipped,
   * so buffers never step twice.
   */
  const requestDraw = useCallback(() => {
    if (state.current.pendingDraw) return;
    state.current.pendingDraw = true;
    requestAnimationFrame(() => {
      if (state.current.pendingDraw) paint(0);
    });
  }, [paint]);

  useFrameLoop(gpu !== null && visible && moving, (_, delta) => paint(delta));

  // The context: held only while the slot is active; the last frame is kept as an image when it goes.
  useEffect(() => {
    if (!active || canvas === null) return;
    const created = ShaderGl.create(canvas);
    if (typeof created === "string") {
      setUnavailable(created);
      return;
    }
    setUnavailable(null);
    gpuRef.current = created;
    setGpu(created);
    const onLost = (event: Event) => {
      // Without preventDefault the browser never restores it.
      event.preventDefault();
      created.lost = true;
      gpuRef.current = null;
      setGpu(null);
    };
    const onRestored = () => setGeneration((value) => value + 1);
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (created.ready && canvas.width > 0) {
        // Drawn in the same task as the capture: the drawing buffer isn't preserved.
        paint(0);
        keepSnapshot(snapshotKey, canvas);
        setShot(snapshot(snapshotKey));
      }
      created.dispose();
      gpuRef.current = null;
      setGpu(null);
    };
    // snapshotKey is read when the context goes, not a reason to rebuild it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, canvas, generation]);

  useEffect(() => {
    if (gpu === null) return;
    setCompileError(gpu.compile(passes, inputNames, texturePaths.length));
    requestDraw();
    // passes, inputNames and the texture count are what programKey names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpu, programKey, requestDraw]);

  // Textures load once per set of paths and outlive the context (re-uploaded to each new one).
  useEffect(() => {
    if (texturePaths.length === 0) {
      setTextures([]);
      setTextureErrors([]);
      return;
    }
    if (loadImage === null) {
      setTextureErrors(["textures: images can't be loaded here"]);
      return;
    }
    let current = true;
    const loaded: ImageBitmap[] = [];
    void Promise.all(texturePaths.map((path) => loadTexture(loadImage, path))).then((results) => {
      for (const result of results) if (result.ok) loaded.push(result.image);
      if (!current) {
        for (const image of loaded) image.close();
        return;
      }
      setTextures(results.map((result) => (result.ok ? result.image : null)));
      setTextureErrors(results.flatMap((result) => (result.ok ? [] : [result.error])));
    });
    return () => {
      current = false;
      for (const image of loaded) image.close();
      // Closed bitmaps can't be uploaded to a context made before the next set arrives.
      setTextures([]);
    };
  }, [texturePaths, loadImage]);

  useEffect(() => {
    if (gpu === null) return;
    for (let index = 0; index < MAX_TEXTURES; index++) gpu.setTexture(index, textures[index] ?? null);
    requestDraw();
  }, [gpu, textures, requestDraw]);

  // Input values, blend and bloom change uniforms only.
  const inputsKey = inputs.join(",");
  useEffect(() => {
    requestDraw();
  }, [inputsKey, blend, bloom, height, yaw, pitch, zoom, requestDraw]);

  useEffect(() => {
    const element = frameRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      state.current.width = element.clientWidth;
      requestDraw();
    });
    state.current.width = element.clientWidth;
    observer.observe(element);
    return () => observer.disconnect();
  }, [requestDraw]);

  /** The pointer in device pixels from the bottom-left, as Shadertoy's iMouse has it. */
  const devicePoint = (event: PointerEvent<HTMLDivElement>): [number, number] => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1);
    return [(event.clientX - bounds.left) * ratio, (bounds.bottom - event.clientY) * ratio];
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const now = state.current;
    const [x, y] = devicePoint(event);
    now.mouse = [x, y, x, y];
    if (orbit) {
      event.currentTarget.setPointerCapture(event.pointerId);
      now.drag = { x: event.clientX, y: event.clientY, yaw: now.yaw, pitch: now.pitch };
    }
    requestDraw();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const now = state.current;
    const [x, y] = devicePoint(event);
    now.mouse = [x, y, now.mouse[2], now.mouse[3]];
    if (now.drag !== null) {
      now.yaw = now.drag.yaw - (event.clientX - now.drag.x) * ORBIT_RATE;
      now.pitch = Math.min(1.5, Math.max(-1.5, now.drag.pitch + (event.clientY - now.drag.y) * ORBIT_RATE));
    }
    requestDraw();
  };
  const onPointerUp = () => {
    const now = state.current;
    now.mouse = [now.mouse[0], now.mouse[1], -1, -1];
    now.drag = null;
    requestDraw();
  };

  const errors = [unavailable, compileError, ...textureErrors].filter((error) => error !== null);
  const eightBit = gpu !== null && !gpu.floatTargets && (passes.length > 1 || bloom > 0);
  const showCanvas = active || gpu !== null;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        ref={frameRef}
        className={cn("relative w-full min-w-0 select-none", orbit && "cursor-grab active:cursor-grabbing")}
        // As in Scene: vertical swipes still scroll the thread on touch; horizontal drags orbit.
        style={{ height, touchAction: orbit ? "pan-y" : "auto" }}
        {...(orbit ? NO_BB_SWIPE : {})}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {showCanvas ? (
          <canvas key={generation} ref={setCanvas} className="absolute inset-0 size-full" />
        ) : shot !== null ? (
          <img src={shot} alt="" className="absolute inset-0 size-full" draggable={false} />
        ) : null}
      </div>
      {errors.map((error) => (
        <ErrorLine key={error} message={error} />
      ))}
      {eightBit && <p className="text-xs text-muted-foreground">This GPU can't render to float textures, so buffers and bloom keep 8 bits per channel.</p>}
    </div>
  );
}
