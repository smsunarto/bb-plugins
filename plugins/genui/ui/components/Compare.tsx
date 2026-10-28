// Compare: is what was built the same as the reference, not just similar?
// The reference and one image compared with it, side by side, as a wipe, as
// an overlay that blinks, or as the pixels that differ beyond a tolerance
// with boxes around the changed regions. Every view shares one zoom and pan.
// It says when the two can't be compared fairly: other sizes (scaled, and by
// how much), other capture conditions (theme, viewport, device…), an image
// that failed to load.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  conditionDifferences,
  conditionsWarning,
  metaKey,
  placement,
  readCompare,
  sizeWarning,
  type CompareImage,
  type Size,
} from "../../core/compare";
import { useUiRuntime } from "../runtime";
import { propsKey, usePersistedState } from "../usePersistedState";
import { formatNumber, TONE_PILL, type Props } from "../values";
import { useWidth } from "./chartKit";
import {
  changedRegions,
  DEFAULT_TOLERANCE,
  diffGrid,
  formatPixelShare,
  MAX_TOLERANCE,
  pixelDiff,
  viewOfRegion,
  type Region,
} from "./compare-logic";
import { ErrorLine } from "./display";
import { FIELD, FOCUS_RING } from "./inputs";
import { imageSource, useImageUrl } from "./media";
import { Frame, Heading, Quiet, Segmented, useOpenUrl } from "./perfKit";
import { ICON_BUTTON } from "./projectKit";
import { NO_BB_SWIPE, useViewer } from "./viewer";
import { clampView, FIT_VIEW, panBy, pinchView, placeImage, wheelZoomFactor, zoomAround, type Point, type View } from "./zoomMath";

type Mode = "side" | "wipe" | "overlay" | "difference";

const MODES: readonly { readonly value: Mode; readonly label: string }[] = [
  { value: "side", label: "Side by side" },
  { value: "wipe", label: "Wipe" },
  { value: "overlay", label: "Overlay" },
  { value: "difference", label: "Difference" },
];

/** The tallest a pane gets; a taller image is fitted inside and zoomed into. */
const MAX_PANE_HEIGHT = 560;
const MIN_PANE_HEIGHT = 140;
const PANE_GAP = 8;
/** Below this frame width, side by side stacks landscape images instead of halving them. */
const STACK_BELOW = 640;
const ZOOM_STEP = 1.5;
const BLINK_MS = 650;
/** The changed-pixel tint: a fixed red-magenta, the convention of pixel-diff tools, readable on light and dark pages. */
const CHANGED_RGB = [255, 0, 80] as const;
const CHANGED_CSS = `rgb(${CHANGED_RGB.join(" ")})`;

const RANGE = cn(
  "h-1 w-full min-w-0 cursor-pointer appearance-none rounded-full",
  "[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-border [&::-webkit-slider-thumb]:bg-background [&::-webkit-slider-thumb]:shadow-[0_1px_3px_rgb(0_0_0/0.18)]",
  "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-border [&::-moz-range-thumb]:bg-background",
  "focus-visible:outline-none focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-ring/30",
);

/** The chip laid over a pane's corner: readable over any image. */
const PANE_TAG =
  "pointer-events-none absolute z-10 max-w-[calc(50%-0.75rem)] truncate rounded-[5px] bg-background/85 px-1.5 text-[10.5px] font-medium leading-[18px] text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.12)]";

export function Compare({ props }: { props: Props }) {
  const read = useMemo(() => readCompare(props.images), [props.images]);
  if (!read.ok) return <ErrorLine message={read.error} />;
  const [reference] = read.images;
  if (reference === undefined || read.images.length < 2) {
    return (
      <Frame label="Image comparison">
        <Quiet>
          {reference === undefined
            ? `No images to compare${read.ignored > 0 ? ` (${read.ignored} without a src)` : ""}.`
            : `Only the reference (${reference.label}) so far: a comparison needs a second image.`}
        </Quiet>
      </Frame>
    );
  }
  return (
    <Frame label="Image comparison">
      <CompareView images={read.images} ignored={read.ignored} />
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Images

/** Natural sizes already decoded, by src: a remounted Compare opens at its final height. */
const SIZES = new Map<string, Size>();

type Decoded =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "ready"; readonly url: string; readonly image: HTMLImageElement; readonly size: Size };

/** An image read through the runtime and decoded, with its natural size. */
function useDecoded(src: string): Decoded {
  const loaded = useImageUrl(src);
  const url = loaded.status === "ready" ? loaded.url : null;
  const [decoded, setDecoded] = useState<{ readonly url: string; readonly image: HTMLImageElement | null } | null>(null);
  useEffect(() => {
    if (url === null) return;
    let live = true;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (!live) return;
      if (image.naturalWidth > 0 && image.naturalHeight > 0) SIZES.set(src, { width: image.naturalWidth, height: image.naturalHeight });
      setDecoded({ url, image: image.naturalWidth > 0 ? image : null });
    };
    image.onerror = () => {
      if (live) setDecoded({ url, image: null });
    };
    image.src = url;
    return () => {
      live = false;
    };
  }, [url, src]);
  if (loaded.status === "failed") return { status: "failed", error: loaded.off ? "web lookups are off in the Generative UI plugin settings" : loaded.error };
  if (url === null || decoded?.url !== url) return { status: "loading" };
  if (decoded.image === null) return { status: "failed", error: "the file is not an image this browser can show" };
  return { status: "ready", url, image: decoded.image, size: { width: decoded.image.naturalWidth, height: decoded.image.naturalHeight } };
}

function knownSize(decoded: Decoded, src: string): Size | null {
  if (decoded.status === "ready") return decoded.size;
  return decoded.status === "loading" ? (SIZES.get(src) ?? null) : null;
}

// ---------------------------------------------------------------------------
// Pixel difference

interface DiffReady {
  readonly status: "ready";
  readonly changed: number;
  readonly total: number;
  /** In reference pixels. */
  readonly regions: readonly Region[];
  readonly more: number;
  /** The changed pixels tinted on transparency, as a data URL; null when none changed. */
  readonly overlay: string | null;
  /** The grid compared, and its scale against the reference (1 unless the reference is huge). */
  readonly grid: Size & { readonly scale: number };
  readonly tolerance: number;
}

type DiffState = { readonly status: "waiting" } | { readonly status: "failed"; readonly error: string } | DiffReady;

/** Results by pair and tolerance, newest last; a few kept so remounts and tolerance changes back are instant. */
const DIFFS = new Map<string, DiffReady>();
const DIFFS_KEPT = 12;
/** The decoded pixels of the last pair compared (one pair only: they can be tens of MB). */
let lastPixels: { readonly pair: string; readonly a: Uint8ClampedArray; readonly b: Uint8ClampedArray } | null = null;

function drawPixels(image: HTMLImageElement, width: number, height: number, drawHeight: number): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("no 2d canvas");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, drawHeight);
  return context.getImageData(0, 0, width, height).data;
}

function computeDiff(reference: HTMLImageElement, candidate: HTMLImageElement, pair: string, tolerance: number): DiffReady | { status: "failed"; error: string } {
  const referenceSize = { width: reference.naturalWidth, height: reference.naturalHeight };
  const fit = placement(referenceSize, { width: candidate.naturalWidth, height: candidate.naturalHeight });
  const grid = diffGrid(referenceSize);
  let pixels = lastPixels?.pair === pair ? lastPixels : null;
  if (pixels === null) {
    try {
      pixels = {
        pair,
        a: drawPixels(reference, grid.width, grid.height, grid.height),
        b: drawPixels(candidate, grid.width, grid.height, Math.round(fit.height * grid.scale)),
      };
    } catch {
      return { status: "failed", error: "the browser would not let the page read these images' pixels" };
    }
    lastPixels = pixels;
  }
  const diff = pixelDiff(pixels.a, pixels.b, grid.width, grid.height, tolerance);
  // About 180 cells across, so a region's granularity follows the image, not its pixel count.
  const cell = Math.max(4, Math.round(Math.max(grid.width, grid.height) / 180));
  const found = changedRegions(diff.mask, grid.width, grid.height, { cell });
  let overlay: string | null = null;
  if (diff.changed > 0) {
    const canvas = document.createElement("canvas");
    canvas.width = grid.width;
    canvas.height = grid.height;
    const context = canvas.getContext("2d");
    if (context !== null) {
      const tint = context.createImageData(grid.width, grid.height);
      for (let pixel = 0; pixel < diff.mask.length; pixel++) {
        if (diff.mask[pixel] !== 1) continue;
        tint.data.set([...CHANGED_RGB, 255], pixel * 4);
      }
      context.putImageData(tint, 0, 0);
      overlay = canvas.toDataURL("image/png");
    }
  }
  const back = 1 / grid.scale;
  return {
    status: "ready",
    changed: diff.changed,
    total: diff.total,
    regions: found.regions.map((region) => ({
      x: region.x * back,
      y: region.y * back,
      width: region.width * back,
      height: region.height * back,
      pixels: region.pixels,
    })),
    more: found.more,
    overlay,
    grid,
    tolerance,
  };
}

/**
 * The pixel difference of the pair at `tolerance`, computed once both images
 * are decoded (after a paint, so the images show first). While a new
 * tolerance computes, the last result for the same pair stays up.
 */
function useDiff(reference: Decoded, candidate: Decoded, pair: string, tolerance: number): DiffState {
  const key = `${pair}\n${tolerance}`;
  const referenceImage = reference.status === "ready" ? reference.image : null;
  const candidateImage = candidate.status === "ready" ? candidate.image : null;
  const [result, setResult] = useState<{ readonly pair: string; readonly key: string; readonly state: DiffState } | null>(null);
  useEffect(() => {
    if (referenceImage === null || candidateImage === null || DIFFS.has(key)) return;
    let live = true;
    const timer = setTimeout(() => {
      const state = computeDiff(referenceImage, candidateImage, pair, tolerance);
      if (state.status === "ready") {
        DIFFS.set(key, state);
        for (const old of DIFFS.keys()) {
          if (DIFFS.size <= DIFFS_KEPT) break;
          DIFFS.delete(old);
        }
      }
      if (live) setResult({ pair, key, state });
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, pair, tolerance, referenceImage, candidateImage]);
  if (referenceImage === null || candidateImage === null) return { status: "waiting" };
  const cached = DIFFS.get(key);
  if (cached !== undefined) return cached;
  return result !== null && result.pair === pair ? result.state : { status: "waiting" };
}

// ---------------------------------------------------------------------------
// The view

function acceptMode(stored: unknown): Mode | null {
  return MODES.find((mode) => mode.value === stored)?.value ?? null;
}

function acceptWhole(max: number): (stored: unknown) => number | null {
  return (stored) => (typeof stored === "number" && Number.isInteger(stored) && stored >= 0 && stored <= max ? stored : null);
}

function CompareView({ images, ignored }: { images: readonly CompareImage[]; ignored: number }) {
  const key = propsKey(images.map((image) => image.src));
  const [mode, setMode] = usePersistedState<Mode>(`${key}:compare-mode`, "side", acceptMode);
  const [picked, setPicked] = usePersistedState<number>(`${key}:compare-with`, 1, acceptWhole(1000));
  const [tolerance, setTolerance] = usePersistedState<number>(`${key}:compare-tolerance`, DEFAULT_TOLERANCE, acceptWhole(MAX_TOLERANCE));
  const [opacity, setOpacity] = usePersistedState<number>(`${key}:compare-opacity`, 50, acceptWhole(100));
  const [view, setView] = useState<View>(FIT_VIEW);
  const [wipe, setWipe] = useState(0.5);
  const [blinking, setBlinking] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  const reference = images[0]!;
  const index = Math.min(Math.max(1, picked), images.length - 1);
  const candidate = images[index]!;
  const referenceImage = useDecoded(reference.src);
  const candidateImage = useDecoded(candidate.src);
  const referenceSize = knownSize(referenceImage, reference.src);
  const candidateSize = knownSize(candidateImage, candidate.src);
  const computed = useDiff(referenceImage, candidateImage, `${reference.src}\n${candidate.src}`, tolerance);
  const unloaded = referenceImage.status === "failed" ? reference : candidateImage.status === "failed" ? candidate : null;
  const diff: DiffState = unloaded === null ? computed : { status: "failed", error: `${unloaded.label} couldn't be loaded` };
  const differences = conditionDifferences(reference, candidate);
  const differing = new Set(differences.map((difference) => metaKey(difference.key)));

  const warnings: { readonly tone: "warn" | "bad"; readonly text: string }[] = [];
  for (const [image, decoded] of [
    [reference, referenceImage],
    [candidate, candidateImage],
  ] as const) {
    if (decoded.status === "failed") warnings.push({ tone: "bad", text: `Couldn't load ${image.label} (${image.src}): ${decoded.error}` });
  }
  const sizes = referenceSize !== null && candidateSize !== null ? sizeWarning(referenceSize, candidateSize, candidate.label) : null;
  if (sizes !== null) warnings.push({ tone: "warn", text: sizes });
  const conditions = conditionsWarning(differences, reference.label, candidate.label);
  if (conditions !== null) warnings.push({ tone: "warn", text: conditions });
  if (diff.status === "ready" && diff.grid.scale < 1) {
    warnings.push({
      tone: "warn",
      text: `The reference is ${formatNumber(referenceSize?.width ?? 0)}×${formatNumber(referenceSize?.height ?? 0)}; pixels are compared at ${Math.round(diff.grid.scale * 100)}% scale (${diff.grid.width}×${diff.grid.height})`,
    });
  }
  if (ignored > 0) warnings.push({ tone: "warn", text: `${ignored} ${ignored === 1 ? "entry" : "entries"} without a src left out` });

  const regionCount = diff.status === "ready" ? diff.regions.length + diff.more : 0;
  const title =
    unloaded !== null
      ? `Can't compare: ${unloaded.label} couldn't be loaded`
      : diff.status === "ready"
        ? diff.changed === 0
          ? "No pixel differs"
          : `${regionCount} changed ${regionCount === 1 ? "region" : "regions"} · ${formatPixelShare(diff.changed, diff.total)} of pixels differ`
        : diff.status === "failed"
          ? "Pixel difference unavailable"
          : `Comparing ${reference.label} with ${candidate.label}`;
  const meta =
    unloaded !== null
      ? "Only what loaded is shown."
      : diff.status === "ready"
        ? diff.changed === 0
          ? `All ${formatNumber(diff.total)} pixels match within ±${diff.tolerance} of 255 per channel`
          : `${formatNumber(diff.changed)} of ${formatNumber(diff.total)} pixels differ by more than ±${diff.tolerance} of 255 in a channel`
        : diff.status === "failed"
          ? `Compare by eye: ${diff.error}.`
          : referenceImage.status === "ready" && candidateImage.status === "ready"
            ? "Computing the pixel difference…"
            : "Loading both images…";

  return (
    <>
      <Heading title={title} meta={meta} />
      {images.length > 2 ? (
        <CandidatePicker images={images} index={index} onPick={(next) => (setPicked(next), setSelected(null))} />
      ) : null}
      <div className="grid min-w-0 gap-2 @xl:grid-cols-2">
        <Identity role="Reference" image={reference} size={referenceImage.status === "failed" ? "failed" : referenceSize} differing={differing} />
        <Identity role="Compared" image={candidate} size={candidateImage.status === "failed" ? "failed" : candidateSize} differing={differing} />
      </div>
      {warnings.length === 0 ? null : (
        <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0">
          {warnings.map((warning) => (
            <li key={warning.text} className={cn("flex min-w-0 items-start gap-1.5 text-xs leading-5", warning.tone === "bad" ? "text-destructive" : "text-warning-text")}>
              <Icon name={warning.tone === "bad" ? "AlertCircle" : "AlertTriangle"} aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{warning.text}</span>
            </li>
          ))}
        </ul>
      )}
      <Stage
        mode={mode}
        onMode={(next) => {
          setMode(next);
          if (next !== "overlay") setBlinking(false);
        }}
        reference={reference}
        candidate={candidate}
        referenceImage={referenceImage}
        candidateImage={candidateImage}
        referenceSize={referenceSize}
        candidateSize={candidateSize}
        diff={diff}
        view={view}
        setView={setView}
        wipe={wipe}
        setWipe={setWipe}
        opacity={opacity}
        setOpacity={setOpacity}
        blinking={blinking}
        setBlinking={setBlinking}
        tolerance={tolerance}
        setTolerance={(next) => {
          setTolerance(next);
          setSelected(null);
        }}
        selected={selected}
        setSelected={setSelected}
      />
    </>
  );
}

function CandidatePicker({ images, index, onPick }: { images: readonly CompareImage[]; index: number; onPick: (index: number) => void }) {
  const candidates = images.slice(1).map((image, position) => ({ value: String(position + 1), label: image.label }));
  const short = candidates.length <= 4 && candidates.reduce((length, option) => length + option.label.length, 0) <= 44;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-xs leading-5 text-muted-foreground">Compare {images[0]!.label} with</span>
      {short ? (
        <Segmented label={`Compare ${images[0]!.label} with`} value={String(index)} options={candidates} onChange={(value) => onPick(Number(value))} />
      ) : (
        <select
          aria-label={`Compare ${images[0]!.label} with`}
          value={String(index)}
          onChange={(event) => onPick(Number(event.currentTarget.value))}
          className={cn(FIELD, "h-7 w-auto max-w-full px-2 text-xs")}
        >
          {candidates.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Which image this is: its role, label, size, where it is, and its capture facts (the ones that differ marked). */
function Identity({ role, image, size, differing }: { role: string; image: CompareImage; size: Size | "failed" | null; differing: ReadonlySet<string> }) {
  const { openFile } = useUiRuntime();
  const openUrl = useOpenUrl();
  const source = imageSource(image.src);
  const open =
    source.kind === "file" && openFile !== null
      ? async () => {
          if (!(await openFile(source.path))) toast.error(`Couldn't open ${source.path}`);
        }
      : source.kind === "url"
        ? () => openUrl(source.url)
        : null;
  const showLabel = !(role === "Reference" && !image.named);
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg bg-surface-recessed/60 px-2.5 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={cn("shrink-0 rounded-full px-1.5 text-[11px] font-medium leading-[18px]", TONE_PILL.neutral)}>{role}</span>
        {showLabel ? (
          <span className="min-w-0 truncate text-[13px] font-medium leading-5 text-foreground" title={image.label}>
            {image.label}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-[11px] leading-5 tabular-nums text-muted-foreground">
          {size === null ? "…" : size === "failed" ? "not loaded" : `${size.width}×${size.height}`}
        </span>
        {open === null ? null : (
          <button type="button" aria-label={`Open ${image.label}`} title={`Open ${image.src}`} onClick={() => void open()} className={cn(ICON_BUTTON, "size-5")}>
            <Icon name={source.kind === "url" ? "ExternalLink" : "FileText"} aria-hidden className="size-3" />
          </button>
        )}
      </div>
      {image.meta.length === 0 ? null : (
        <div className="flex min-w-0 flex-wrap gap-1">
          {image.meta.map(([metaName, value]) => {
            const differs = differing.has(metaKey(metaName));
            return (
              <span
                key={metaName}
                title={differs ? `${metaName} differs between the two` : undefined}
                className={cn("max-w-full truncate rounded px-1.5 text-[11px] leading-[18px]", differs ? TONE_PILL.warn : "bg-background text-muted-foreground")}
              >
                <span className="opacity-75">{metaName}</span> {value}
              </span>
            );
          })}
        </div>
      )}
      {image.note === null ? null : <p className="m-0 text-xs leading-5 text-muted-foreground">{image.note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage: the panes, their shared zoom and pan, and the mode's own controls

type Gesture =
  | { readonly kind: "pan"; last: Point }
  | { readonly kind: "divider" }
  | { readonly kind: "pinch"; readonly from: readonly [Point, Point]; readonly view: View };

interface StageProps {
  mode: Mode;
  onMode: (mode: Mode) => void;
  reference: CompareImage;
  candidate: CompareImage;
  referenceImage: Decoded;
  candidateImage: Decoded;
  referenceSize: Size | null;
  candidateSize: Size | null;
  diff: DiffState;
  view: View;
  setView: (next: View | ((previous: View) => View)) => void;
  wipe: number;
  setWipe: (next: number) => void;
  opacity: number;
  setOpacity: (next: number) => void;
  blinking: boolean;
  setBlinking: (next: boolean | ((previous: boolean) => boolean)) => void;
  tolerance: number;
  setTolerance: (next: number) => void;
  selected: number | null;
  setSelected: (next: number | null) => void;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function Stage(props: StageProps) {
  const { mode, reference, candidate, referenceImage, candidateImage, referenceSize, candidateSize, diff, view, setView, wipe, setWipe } = props;
  const [frame, width] = useWidth<HTMLDivElement>();
  const stage = useRef<HTMLDivElement>(null);
  const image: Size = referenceSize ?? { width: 1600, height: 1000 };
  const aspect = image.height / image.width;
  const stacked = mode === "side" && width > 0 && width < STACK_BELOW && aspect <= 1;
  const paneWidth = Math.max(0, Math.floor(mode === "side" && !stacked ? (width - PANE_GAP) / 2 : width));
  // The pane's content box (inside its 1px border) is what the geometry uses.
  const pane: Size = {
    width: Math.max(1, paneWidth - 2),
    height: Math.round(Math.min(MAX_PANE_HEIGHT, Math.max(MIN_PANE_HEIGHT, Math.min(paneWidth, image.width) * aspect))),
  };
  const shown = clampView(view, pane, image);
  const placed = placeImage(shown, pane, image);
  const fit = candidateSize === null || referenceSize === null ? null : placement(referenceSize, candidateSize);
  const candidateBox: Size = { width: image.width, height: fit?.height ?? image.height };
  const percent = Math.round(placed.scale * 100);
  const referenceLabel = reference.named ? `Reference · ${reference.label}` : "Reference";
  // Full screen, the two pictures one after the other (arrows or a swipe step between them).
  const { open, viewer } = useViewer(
    [
      { decoded: referenceImage, caption: referenceLabel },
      { decoded: candidateImage, caption: candidate.label },
    ].flatMap(({ decoded, caption }) => (decoded.status === "ready" ? [{ url: decoded.url, alt: caption, caption }] : [])),
  );

  // Live values for the native wheel listener and the gestures.
  const live = useRef({ pane, image, shown, mode });
  live.current = { pane, image, shown, mode };
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const travel = useRef(0);

  useEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      const paneElement = (event.target as Element).closest<HTMLElement>("[data-compare-pane]");
      if (paneElement === null) return;
      const { pane: size, image: picture, shown: current } = live.current;
      const rect = paneElement.getBoundingClientRect();
      const at = { x: event.clientX - rect.left - paneElement.clientLeft, y: event.clientY - rect.top - paneElement.clientTop };
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setView(zoomAround(current, wheelZoomFactor(event.deltaY, event.deltaMode, size.height), at, size, picture));
        return;
      }
      const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
      if (current.zoom <= 1) return;
      const next = panBy(current, -event.deltaX * lines, -event.deltaY * lines, size, picture);
      // At an edge the page scrolls on, as everywhere else in the conversation.
      if (Math.abs(next.cx - current.cx) < 1e-6 && Math.abs(next.cy - current.cy) < 1e-6) return;
      event.preventDefault();
      setView(next);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [setView]);

  const local = (event: PointerEvent): Point => ({ x: event.clientX - (origin.current?.x ?? 0), y: event.clientY - (origin.current?.y ?? 0) });

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.target as Element;
    const paneElement = target.closest<HTMLElement>("[data-compare-pane]");
    if (paneElement === null) return;
    if (pointers.current.size === 0) {
      const rect = paneElement.getBoundingClientRect();
      origin.current = { x: rect.left + paneElement.clientLeft, y: rect.top + paneElement.clientTop };
      travel.current = 0;
    }
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 2) {
      gesture.current = { kind: "pinch", from: [...pointers.current.values()] as [Point, Point], view: live.current.shown };
      return;
    }
    if (pointers.current.size > 2) return;
    const onDivider = target.closest("[data-compare-divider]") !== null;
    if (mode === "wipe" && (onDivider || live.current.shown.zoom <= 1)) {
      gesture.current = { kind: "divider" };
      if (!onDivider) setWipe(clamp01(point.x / live.current.pane.width));
      if (onDivider) event.currentTarget.setPointerCapture(event.pointerId);
    } else {
      gesture.current = { kind: "pan", last: point };
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (previous === undefined) return;
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    travel.current += Math.hypot(point.x - previous.x, point.y - previous.y);
    // Capture once it is a drag, so a plain click still reaches the button under it.
    if (travel.current > 4 && !event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
    const current = gesture.current;
    const { pane: size, image: picture } = live.current;
    if (current === null) return;
    if (current.kind === "pinch") {
      setView(pinchView(current.view, current.from, [...pointers.current.values()] as [Point, Point], size, picture));
    } else if (current.kind === "pan") {
      const dx = point.x - current.last.x;
      const dy = point.y - current.last.y;
      current.last = point;
      setView((before) => panBy(clampView(before, size, picture), dx, dy, size, picture));
    } else {
      setWipe(clamp01(point.x / size.width));
    }
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    const [rest] = [...pointers.current.values()];
    if (rest !== undefined && gesture.current?.kind === "pinch") gesture.current = { kind: "pan", last: rest };
    else if (rest === undefined) gesture.current = null;
  };

  const zoomBy = (factor: number) => setView(zoomAround(shown, factor, { x: pane.width / 2, y: pane.height / 2 }, pane, image));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = 0.1;
    const arrows: Record<string, readonly [number, number]> = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP);
    else if (event.key === "-" || event.key === "_") zoomBy(1 / ZOOM_STEP);
    else if (event.key === "0") setView(FIT_VIEW);
    else if (Object.hasOwn(arrows, event.key) && shown.zoom > 1) {
      const [x, y] = arrows[event.key]!;
      setView(panBy(shown, x * pane.width * step, y * pane.height * step, pane, image));
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && mode === "wipe") {
      setWipe(clamp01(wipe + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 0.1 : 0.02)));
    } else return;
    event.preventDefault();
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    const paneElement = target.closest<HTMLElement>("[data-compare-pane]");
    if (paneElement === null || target.closest("[data-compare-divider], button") !== null) return;
    if (shown.zoom > 1.01) {
      setView(FIT_VIEW);
      return;
    }
    const rect = paneElement.getBoundingClientRect();
    setView(zoomAround(shown, 3, { x: event.clientX - rect.left - paneElement.clientLeft, y: event.clientY - rect.top - paneElement.clientTop }, pane, image));
  };

  const layer = (decoded: Decoded, alt: string, box: Size, style?: CSSProperties, imageClassName?: string): ReactNode =>
    decoded.status === "ready" ? (
      <div
        className="pointer-events-none absolute left-0 top-0 origin-top-left overflow-hidden"
        style={{ width: image.width, height: image.height, transform: `translate(${placed.x}px, ${placed.y}px) scale(${placed.scale})`, ...style }}
      >
        <img
          src={decoded.url}
          alt={alt}
          draggable={false}
          className={cn("absolute left-0 top-0 max-w-none select-none", imageClassName)}
          style={{ width: box.width, height: box.height, imageRendering: placed.scale >= 2 ? "pixelated" : undefined }}
        />
      </div>
    ) : null;

  const paneState = (decoded: Decoded, label: string): ReactNode =>
    decoded.status === "loading" ? (
      <div role="status" aria-label={`Loading ${label}`} className="absolute inset-0 animate-pulse bg-muted/40 motion-reduce:animate-none" />
    ) : decoded.status === "failed" ? (
      <p className="absolute inset-0 m-0 flex items-center justify-center p-4">
        <span className="rounded-md bg-background/90 px-2 py-1 text-center text-xs leading-5 text-destructive shadow-[0_1px_2px_rgb(0_0_0/0.12)]">Couldn't load {label}</span>
      </p>
    ) : null;

  const paneClass = cn(
    "relative shrink-0 select-none overflow-hidden rounded-lg border border-border bg-surface-recessed",
    shown.zoom > 1 ? "cursor-grab active:cursor-grabbing" : mode === "wipe" ? "cursor-ew-resize" : "cursor-zoom-in",
  );
  const paneStyle: CSSProperties = { width: paneWidth || "100%", height: pane.height + 2 };
  const candidateLabel = candidate.label;

  let panes: ReactNode;
  if (mode === "side") {
    const caption = (role: string, label: string | null) => (
      <span className="truncate text-xs leading-5 text-muted-foreground">
        <span className="font-medium text-foreground">{role}</span>
        {label === null ? null : ` · ${label}`}
      </span>
    );
    panes = (
      <>
        <div className="flex min-w-0 flex-col gap-1" style={{ width: paneWidth || "100%" }}>
          {caption("Reference", reference.named ? reference.label : null)}
          <div data-compare-pane className={paneClass} style={paneStyle}>
            {layer(referenceImage, reference.label, image)}
            {paneState(referenceImage, reference.label)}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-1" style={{ width: paneWidth || "100%" }}>
          {caption(candidateLabel, null)}
          <div data-compare-pane className={paneClass} style={paneStyle}>
            {layer(candidateImage, candidateLabel, candidateBox)}
            {paneState(candidateImage, candidateLabel)}
          </div>
        </div>
      </>
    );
  } else if (mode === "wipe") {
    const at = wipe * pane.width;
    panes = (
      <div data-compare-pane className={paneClass} style={paneStyle}>
        {layer(referenceImage, reference.label, image)}
        <div className="pointer-events-none absolute inset-0" style={{ clipPath: `inset(0 0 0 ${at}px)` }}>
          {layer(candidateImage, candidateLabel, candidateBox)}
        </div>
        {paneState(referenceImage.status !== "ready" ? referenceImage : candidateImage, referenceImage.status !== "ready" ? reference.label : candidateLabel)}
        <span className={cn(PANE_TAG, "left-2 top-2")}>{referenceLabel}</span>
        <span className={cn(PANE_TAG, "right-2 top-2")}>{candidateLabel}</span>
        <div
          data-compare-divider
          role="slider"
          tabIndex={0}
          aria-label="Wipe divider"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(wipe * 100)}
          aria-valuetext={`${Math.round(wipe * 100)}%: ${reference.label} on the left, ${candidateLabel} on the right`}
          onKeyDown={(event) => {
            const small = event.shiftKey ? 0.1 : 0.01;
            const moves: Record<string, number> = { ArrowLeft: -small, ArrowDown: -small, ArrowRight: small, ArrowUp: small, PageDown: -0.1, PageUp: 0.1 };
            if (event.key === "Home") setWipe(0);
            else if (event.key === "End") setWipe(1);
            else if (Object.hasOwn(moves, event.key)) setWipe(clamp01(wipe + moves[event.key]!));
            else return;
            event.preventDefault();
            event.stopPropagation();
          }}
          className={cn("group/divider absolute inset-y-0 z-20 w-11 -translate-x-1/2 cursor-ew-resize touch-none rounded-sm", FOCUS_RING)}
          style={{ left: at }}
        >
          <span aria-hidden className="absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 bg-white shadow-[0_0_3px_rgb(0_0_0/0.45)]" />
          <span
            aria-hidden
            className="absolute left-1/2 top-1/2 flex h-8 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-[3px] rounded-full bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.12),0_1px_4px_rgb(0_0_0/0.3)] transition-transform duration-150 group-active/divider:scale-110 motion-reduce:transition-none"
          >
            <span className="h-3 w-px rounded-full bg-neutral-500" />
            <span className="h-3 w-px rounded-full bg-neutral-500" />
          </span>
        </div>
      </div>
    );
  } else if (mode === "overlay") {
    const blinkOn = props.blinking;
    panes = (
      <OverlayPane
        paneClass={paneClass}
        paneStyle={paneStyle}
        blinking={blinkOn}
        opacity={props.opacity}
        reference={(style) => layer(referenceImage, reference.label, image, style)}
        candidate={(style) => layer(candidateImage, candidateLabel, candidateBox, style)}
        state={paneState(referenceImage.status !== "ready" ? referenceImage : candidateImage, referenceImage.status !== "ready" ? reference.label : candidateLabel)}
        referenceLabel={reference.label}
        candidateLabel={candidateLabel}
      />
    );
  } else {
    const ready = diff.status === "ready" ? diff : null;
    panes = (
      <div data-compare-pane className={paneClass} style={paneStyle}>
        {layer(referenceImage, reference.label, image, undefined, "opacity-30 grayscale")}
        {ready?.overlay != null ? (
          <div
            className="pointer-events-none absolute left-0 top-0 origin-top-left"
            style={{ width: image.width, height: image.height, transform: `translate(${placed.x}px, ${placed.y}px) scale(${placed.scale})` }}
          >
            <img src={ready.overlay} alt="" draggable={false} className="absolute inset-0 size-full max-w-none select-none [image-rendering:pixelated]" />
          </div>
        ) : null}
        {ready?.regions.map((region, position) => {
          const pad = 3;
          const left = placed.x + region.x * placed.scale - pad;
          const top = placed.y + region.y * placed.scale - pad;
          const boxWidth = Math.max(12, region.width * placed.scale + pad * 2);
          const boxHeight = Math.max(12, region.height * placed.scale + pad * 2);
          return (
            <span key={`${region.x},${region.y}`} className="contents">
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Zoom to changed region ${position + 1}`}
                title={`Region ${position + 1}: ${Math.round(region.width)}×${Math.round(region.height)} px`}
                onClick={() => {
                  if (travel.current > 4) return;
                  props.setSelected(position);
                  setView(viewOfRegion(region, pane, image));
                }}
                className={cn(
                  "absolute cursor-zoom-in rounded-[3px] border-[1.5px] p-0 transition-[border-color,box-shadow] duration-150 hover:shadow-[0_0_0_3px_rgb(255_0_80/0.25)]",
                  props.selected === position ? "border-foreground" : "border-[rgb(255_0_80)]",
                )}
                style={{ left, top, width: boxWidth, height: boxHeight }}
              />
              <span
                aria-hidden
                className="pointer-events-none absolute rounded-sm bg-[rgb(255_0_80)] px-1 text-[10px] font-semibold leading-4 text-white"
                style={{ left, top: top < 18 ? top + boxHeight + 2 : top - 18 }}
              >
                {position + 1}
              </span>
            </span>
          );
        }) ?? null}
        {paneState(referenceImage.status !== "ready" ? referenceImage : candidateImage, referenceImage.status !== "ready" ? reference.label : candidateLabel)}
        <span className={cn(PANE_TAG, "left-2 top-2 inline-flex items-center gap-1.5")}>
          <span aria-hidden className="size-2 rounded-[2px]" style={{ background: CHANGED_CSS }} />
          {diff.status === "ready" ? `Changed in ${candidateLabel}` : diff.status === "failed" ? "Difference unavailable" : "Computing the difference…"}
        </span>
      </div>
    );
  }

  const zoomed = shown.zoom > 1.001;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <Segmented label="View" value={mode} options={MODES} onChange={props.onMode} />
        <div role="group" aria-label="Zoom" className="flex items-center gap-0.5">
          <button type="button" aria-label="Zoom out" title="Zoom out (−)" disabled={!zoomed} onClick={() => zoomBy(1 / ZOOM_STEP)} className={ICON_BUTTON}>
            <Icon name="ZoomOut" aria-hidden className="size-3.5" />
          </button>
          <span className="w-11 text-center text-xs leading-5 tabular-nums text-muted-foreground" aria-label={`Zoom ${percent}% of actual pixels`}>
            {percent}%
          </span>
          <button type="button" aria-label="Zoom in" title="Zoom in (+)" disabled={shown.zoom >= 31.99} onClick={() => zoomBy(ZOOM_STEP)} className={ICON_BUTTON}>
            <Icon name="ZoomIn" aria-hidden className="size-3.5" />
          </button>
          <button type="button" aria-label="Fit" title="Fit (0)" disabled={!zoomed} onClick={() => setView(FIT_VIEW)} className={ICON_BUTTON}>
            <Icon name="RotateCcw" aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Open full screen"
            title="Open full screen"
            disabled={referenceImage.status !== "ready" && candidateImage.status !== "ready"}
            onClick={(event) => open(0, event.currentTarget)}
            className={ICON_BUTTON}
          >
            <Icon name="Maximize2" aria-hidden className="size-3.5" />
          </button>
        </div>
      </div>
      <div ref={frame} className="min-w-0">
        <div
          ref={stage}
          tabIndex={0}
          role="group"
          aria-roledescription="image comparison"
          aria-label={`${MODES.find((option) => option.value === mode)?.label}: ${reference.label} and ${candidateLabel}, zoom ${percent}%. Plus and minus zoom, 0 fits, arrow keys pan when zoomed${mode === "wipe" ? " or move the divider" : ""}.`}
          {...NO_BB_SWIPE}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onDoubleClick={onDoubleClick}
          onKeyDown={onKeyDown}
          className={cn("flex min-w-0 rounded-lg", stacked || mode !== "side" ? "flex-col" : "flex-row", FOCUS_RING)}
          style={{ gap: PANE_GAP, touchAction: zoomed ? "none" : "pan-y" }}
        >
          {panes}
        </div>
      </div>
      <ModeControls {...props} pane={pane} image={image} />
      {viewer}
    </div>
  );
}

function OverlayPane({
  paneClass,
  paneStyle,
  blinking,
  opacity,
  reference,
  candidate,
  state,
  referenceLabel,
  candidateLabel,
}: {
  paneClass: string;
  paneStyle: CSSProperties;
  blinking: boolean;
  opacity: number;
  reference: (style?: CSSProperties) => ReactNode;
  candidate: (style?: CSSProperties) => ReactNode;
  state: ReactNode;
  referenceLabel: string;
  candidateLabel: string;
}) {
  const [phase, setPhase] = useState(true);
  useEffect(() => {
    if (!blinking) return;
    const timer = setInterval(() => setPhase((shown) => !shown), BLINK_MS);
    return () => clearInterval(timer);
  }, [blinking]);
  const shownCandidate = blinking ? phase : null;
  return (
    <div data-compare-pane className={paneClass} style={paneStyle}>
      {reference()}
      {candidate({ opacity: shownCandidate === null ? opacity / 100 : shownCandidate ? 1 : 0 })}
      {state}
      <span className={cn(PANE_TAG, "left-2 top-2")} aria-live={blinking ? "off" : "polite"}>
        {shownCandidate === null ? `${candidateLabel} at ${opacity}% over ${referenceLabel}` : shownCandidate ? candidateLabel : referenceLabel}
      </span>
    </div>
  );
}

/** The row under the stage: what the current mode lets the user tune, at one height for every mode. */
function ModeControls(props: StageProps & { pane: Size; image: Size }) {
  const { mode, diff, candidate, reference } = props;
  if (mode === "overlay") {
    return (
      <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex min-w-[12rem] flex-1 items-center gap-2 text-xs leading-5 text-muted-foreground">
          <span className="shrink-0">Opacity of {candidate.label}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={props.opacity}
            disabled={props.blinking}
            onChange={(event) => props.setOpacity(Number(event.currentTarget.value))}
            className={cn(RANGE, "disabled:opacity-50")}
            style={{ background: `linear-gradient(to right, var(--primary) ${props.opacity}%, var(--muted) ${props.opacity}%)` }}
          />
          <span className="w-9 shrink-0 text-right tabular-nums text-foreground">{props.opacity}%</span>
        </label>
        <button
          type="button"
          aria-pressed={props.blinking}
          onClick={() => props.setBlinking((on) => !on)}
          className={cn(
            "h-7 shrink-0 cursor-pointer rounded-md border border-border px-2.5 text-xs transition-colors duration-150",
            FOCUS_RING,
            props.blinking ? "bg-foreground text-background" : "bg-background text-foreground hover:bg-state-hover",
          )}
        >
          Blink
        </button>
      </div>
    );
  }
  if (mode === "difference") {
    const ready = diff.status === "ready" ? diff : null;
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <label className="flex min-h-7 min-w-0 items-center gap-2 text-xs leading-5 text-muted-foreground">
          <span className="shrink-0">Tolerance</span>
          <input
            type="range"
            min={0}
            max={MAX_TOLERANCE}
            step={1}
            value={props.tolerance}
            aria-valuetext={`plus or minus ${props.tolerance} of 255 per channel`}
            onChange={(event) => props.setTolerance(Number(event.currentTarget.value))}
            className={cn(RANGE, "max-w-64")}
            style={{ background: `linear-gradient(to right, var(--primary) ${(props.tolerance / MAX_TOLERANCE) * 100}%, var(--muted) ${(props.tolerance / MAX_TOLERANCE) * 100}%)` }}
          />
          <span className="shrink-0 tabular-nums text-foreground">±{props.tolerance}</span>
          <span className="hidden shrink-0 @md:inline">of 255 per channel</span>
        </label>
        <div className="flex h-6 min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {ready === null ? (
            <span className="text-xs leading-5 text-muted-foreground">{diff.status === "failed" ? `No difference: ${diff.error}` : "Finding changed regions…"}</span>
          ) : ready.regions.length === 0 ? (
            <span className="text-xs leading-5 text-muted-foreground">No changed regions at ±{ready.tolerance}.</span>
          ) : (
            <>
              <span className="shrink-0 text-xs leading-5 text-muted-foreground">Regions</span>
              {ready.regions.map((region, position) => (
                <button
                  key={`${region.x},${region.y}`}
                  type="button"
                  aria-pressed={props.selected === position}
                  aria-label={`Zoom to changed region ${position + 1}: ${Math.round(region.width)} by ${Math.round(region.height)} pixels at ${Math.round(region.x)}, ${Math.round(region.y)}`}
                  onClick={() => {
                    props.setSelected(position);
                    props.setView(viewOfRegion(region, props.pane, props.image));
                  }}
                  className={cn(
                    "h-6 shrink-0 cursor-pointer whitespace-nowrap rounded-md px-1.5 text-[11px] tabular-nums transition-colors duration-150",
                    FOCUS_RING,
                    props.selected === position ? "bg-foreground text-background" : "bg-surface-recessed text-foreground hover:bg-state-hover",
                  )}
                >
                  <span className="font-semibold">{position + 1}</span> · {Math.round(region.width)}×{Math.round(region.height)}
                </button>
              ))}
              {ready.more > 0 ? <span className="shrink-0 text-[11px] text-muted-foreground">+{ready.more} smaller</span> : null}
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <p className="m-0 flex min-h-7 items-center text-xs leading-5 text-muted-foreground">
      {mode === "wipe"
        ? `Drag the divider, or focus it and use ← →. ${reference.label} is on the left.`
        : "Zoom and pan move both images together: pinch or ⌘/Ctrl + scroll, double-tap, or + and −; drag to pan."}
    </p>
  );
}
