// Map: numbered places on OpenStreetMap tiles beside a list of them with
// their notes (below the map on a phone). Pins and list rows highlight each
// other; the map fits every place, pans and zooms by drag, pinch, ctrl/⌘ +
// wheel, double click, buttons and keys, and can join the places in order
// with a route line. For trips: places group by day (a colour each, a
// legend, a route line per day), a place naming a Wikipedia article shows
// its credited lead photo on its card, and a tour drops the pins one by one.
// No map library: the projection, tiling and tour pace are mapMath.ts; tiles,
// place names and photos come through the backend (web/lookups.ts).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { groupByDay, readPlaces, type MapPlace } from "../../core/map";
import type { rpcContract } from "../../server";
import { list, type Props } from "../values";
import { useDarkTheme } from "../theme";
import { cachedTile, geocode, loadTile, useWikiPhoto, type PlaceResult } from "../webLookups";
import { PALETTE } from "./chartKit";
import { ErrorLine } from "./display";
import { useImageUrl, WebOffLine } from "./media";
import {
  clampView,
  fitView,
  MAX_ZOOM,
  pan,
  project,
  tileZoom,
  toScreen,
  tourStep,
  visibleTiles,
  zoomAround,
  type Point,
  type Size,
  type View,
} from "./mapMath";
import { EASE_OUT_EXPO, reducedMotion, RISE, useAnimationsOff, useEntrance } from "./motion";
import { NO_BB_SWIPE } from "./viewer";
import { Credit, Fill } from "./webMedia";

/** How long the last place must stay unchanged before its name is looked up (it may still be streaming its lat/lng). */
const SETTLE_MS = 700;
const PADDING = 44;
const SINGLE_PLACE_ZOOM = 14;
const FIT_MAX_ZOOM = 15;
/** Movement before a press becomes a drag (so a tap on a pin stays a click). */
const DRAG_PX = 4;

function lookupKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Looks up the places that have no coordinates, one at a time in order, each
 * nudged toward the places already known (the backend keeps to Photon's
 * one-request-a-second). Results by lowercased name.
 */
function useLookups(places: readonly (MapPlace | null)[]): ReadonlyMap<string, PlaceResult> {
  const rpc = useRpc<typeof rpcContract>();
  const [found, setFound] = useState<ReadonlyMap<string, PlaceResult>>(() => new Map());
  const busy = useRef(false);
  const signature = JSON.stringify(places);
  const [settled, setSettled] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(signature), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [signature]);

  useEffect(() => {
    if (busy.current) return;
    const pending = places.findIndex(
      (place, index) =>
        place !== null &&
        place.given === null &&
        !found.has(lookupKey(place.name)) &&
        (index < places.length - 1 || settled === signature),
    );
    const place = pending === -1 ? null : places[pending];
    if (place === null) return;
    const known = places.flatMap((other) => {
      if (other === null) return [];
      if (other.given !== null) return [other.given];
      const result = found.get(lookupKey(other.name));
      return result?.ok ? [{ lat: result.lat, lng: result.lng }] : [];
    });
    const near =
      known.length === 0
        ? null
        : {
            lat: known.reduce((sum, at) => sum + at.lat, 0) / known.length,
            lng: known.reduce((sum, at) => sum + at.lng, 0) / known.length,
          };
    busy.current = true;
    void geocode(rpc, place.name, near).then((result) => {
      busy.current = false;
      setFound((previous) => new Map(previous).set(lookupKey(place.name), result));
    });
  }, [rpc, places, found, settled, signature]);

  return found;
}

/** One map tile: fetched when drawn, faded in once decoded. */
function MapTile({ z, x, y, left, top, size, onOff }: { z: number; x: number; y: number; left: number; top: number; size: number; onOff: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const key = `${z}/${x}/${y}`;
  const [url, setUrl] = useState<{ readonly key: string; readonly url: string } | null>(() => {
    const cached = cachedTile(z, x, y);
    return cached === null ? null : { key, url: cached };
  });
  const [shown, setShown] = useState(url !== null);
  useEffect(() => {
    if (url?.key === key) return;
    let live = true;
    void loadTile(rpc, z, x, y).then((result) => {
      if (!live) return;
      if (result.ok) setUrl({ key, url: result.dataUrl });
      else if (result.off === true) onOff();
    });
    return () => {
      live = false;
    };
  }, [rpc, z, x, y, key, url, onOff]);
  if (url?.key !== key) return null;
  return (
    <img
      src={url.url}
      alt=""
      draggable={false}
      onLoad={() => setShown(true)}
      className={cn("absolute max-w-none select-none transition-opacity duration-200 motion-reduce:transition-none", shown ? "opacity-100" : "opacity-0")}
      // Half a pixel of overlap hides seams between fractional-zoom tiles.
      style={{ left: Math.floor(left), top: Math.floor(top), width: Math.ceil(size) + 1, height: Math.ceil(size) + 1 }}
    />
  );
}

/** Tiles of an earlier level the page already holds, drawn under the current level while it loads. */
function Backdrop({ view, size, z }: { view: View; size: Size; z: number }) {
  const tiles = visibleTiles(view, size, z);
  if (tiles.length > 48) return null;
  return tiles.map((tile) => {
    const url = cachedTile(tile.z, tile.x, tile.y);
    return url === null ? null : (
      <img
        key={tile.key}
        src={url}
        alt=""
        draggable={false}
        className="absolute max-w-none select-none"
        style={{ left: Math.floor(tile.left), top: Math.floor(tile.top), width: Math.ceil(tile.size) + 1, height: Math.ceil(tile.size) + 1 }}
      />
    );
  });
}

// A shadow keeps the white number legible on the lighter day colours.
const MARKER = "flex shrink-0 items-center justify-center rounded-full font-semibold tabular-nums text-white [text-shadow:0_0_2px_rgb(0_0_0/0.45)]";
const CONTROL =
  "flex size-8 cursor-pointer items-center justify-center bg-background text-foreground transition-colors hover:bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";
const TOUR_BUTTON =
  "flex h-7 cursor-pointer items-center gap-1 bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

type Gesture =
  | { readonly kind: "press"; readonly id: number; readonly x: number; readonly y: number; readonly view: View }
  | { readonly kind: "drag"; readonly id: number; readonly x: number; readonly y: number; readonly view: View }
  | { readonly kind: "pinch"; readonly distance: number; readonly mid: { left: number; top: number }; readonly view: View };

/** Day colours: the chart palette without its quiet grey (it would read as a stop not found yet), softened past its end. */
const DAY_COLORS = PALETTE.filter((_, index) => index !== 1);

function dayColor(group: number): string {
  const color = DAY_COLORS[group % DAY_COLORS.length];
  return group < DAY_COLORS.length ? color : `color-mix(in oklch, ${color} 50%, var(--background))`;
}

/** A pin dropping in on a tour: falls from a little above while it fades in. */
const DROP: Keyframe[] = [
  { transform: "translateY(-18px)", opacity: 0 },
  { transform: "none", opacity: 1 },
];
const DROP_MS = 420;

/** Plays the drop on a pin wrapper the tour marked as its newest (`data-drop`), once, when it mounts. */
function dropIn(element: HTMLElement | null): void {
  if (element?.dataset.drop === "true" && !reducedMotion()) element.animate(DROP, { duration: DROP_MS, easing: EASE_OUT_EXPO });
}

interface Tour {
  /** Whether the tour runs at all: asked for, and motion allowed. */
  readonly active: boolean;
  /** How many stops, in tour order, have their pins down. */
  readonly shown: number;
  readonly started: boolean;
  readonly paused: boolean;
  readonly done: boolean;
  /** Bumped by replay, so the pins mount (and drop) again. */
  readonly epoch: number;
  /** When (performance.now()) the newest pin dropped on its own; a seek doesn't count. */
  readonly droppedAt: number;
  readonly toggle: () => void;
  readonly replay: () => void;
  /** Shows the stops up to `position` and carries on from there. */
  readonly seek: (position: number) => void;
}

/**
 * Drops `count` pins one by one at tourStep's pace, starting once `target`
 * (the map) is mostly on screen. Only the pins move: the camera and the page
 * stay where the user left them. Pauses while the page is hidden; reduced
 * motion or the Animations setting off shows every pin at once.
 */
function useTour(wanted: boolean, count: number, target: RefObject<HTMLElement | null>): Tour {
  const animationsOff = useAnimationsOff();
  // The system setting has no hook; it's read again on every render.
  const active = wanted && !animationsOff && !reducedMotion();
  const [started, setStarted] = useState(false);
  const [shown, setShown] = useState(0);
  const [paused, setPaused] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [droppedAt, setDroppedAt] = useState(Number.NEGATIVE_INFINITY);
  const [hidden, setHidden] = useState(() => document.visibilityState === "hidden");

  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const element = target.current;
    if (!active || started || element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setStarted(true);
        setShown(1);
        setDroppedAt(performance.now());
      },
      { threshold: 0.6 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, started, target]);

  const running = active && started && !paused && !hidden && shown < count;
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => {
      setShown((current) => current + 1);
      setDroppedAt(performance.now());
    }, tourStep(count));
    return () => clearTimeout(timer);
  }, [running, shown, count]);

  return {
    active,
    shown: active ? shown : count,
    started,
    paused,
    done: shown >= count,
    epoch,
    droppedAt,
    toggle: () => setPaused((current) => !current),
    replay: () => {
      setStarted(true);
      setShown(1);
      setPaused(false);
      setEpoch((current) => current + 1);
      setDroppedAt(performance.now());
    },
    seek: (position) => {
      setStarted(true);
      setShown(position + 1);
    },
  };
}

const SKELETON = "animate-pulse bg-surface-recessed motion-reduce:animate-none";

/**
 * A place's Wikipedia lead photo with its credit, under its card text. The
 * backend answers only with a photo it can credit; with none, nothing shows.
 */
function PlacePhoto({ title, name, onOff }: { title: string; name: string; onOff: () => void }) {
  const found = useWikiPhoto(title);
  const photo = found?.ok ? found.photo : null;
  const image = useImageUrl(photo?.url ?? null);
  const [broken, setBroken] = useState<string | null>(null);
  const off = (found !== null && !found.ok && found.off === true) || (image.status === "failed" && image.off);
  useEffect(() => {
    if (off) onOff();
  }, [off, onOff]);
  if (found === null) return <span aria-hidden className={cn("ml-[38px] mr-2 mb-1.5 block aspect-[16/9] rounded-md", SKELETON)} />;
  if (photo === null || off) return null;
  const url = image.status === "ready" ? image.url : null;
  if (image.status === "failed" || (url !== null && broken === url)) {
    return <p className="mb-1.5 ml-[38px] mr-2 text-[11px] leading-4 text-muted-foreground">Couldn't load the photo.</p>;
  }
  return (
    <figure className="mb-1.5 ml-[38px] mr-2 flex min-w-0 flex-col gap-1">
      <div className="relative aspect-[16/9] overflow-hidden rounded-md border border-border bg-surface-recessed">
        {url === null ? <span aria-hidden className={cn("absolute inset-0", SKELETON)} /> : <Fill url={url} alt={name} onFailed={() => setBroken(url)} />}
      </div>
      <figcaption>
        <Credit image={photo} compact />
      </figcaption>
    </figure>
  );
}

export function MapView({ props }: { props: Props }) {
  const items = list(props.places);
  const places = useMemo(() => readPlaces(items), [items]);
  const route = props.route === true;
  const lookups = useLookups(places);
  const dark = useDarkTheme();
  const rise = useEntrance<HTMLDivElement>(RISE);

  const viewport = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [view, setView] = useState<View | null>(null);
  /** A tile or photo answered that web lookups are off. */
  const [webOff, setWebOff] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  /** The level whose tiles finished loading last: drawn as a backdrop while another loads. */
  const [backdropZ, setBackdropZ] = useState<number | null>(null);
  const moved = useRef(false);
  const animation = useRef<number | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);

  const located = places.map((place) => {
    if (place === null) return null;
    if (place.given !== null) return place.given;
    const result = lookups.get(lookupKey(place.name));
    return result?.ok ? { lat: result.lat, lng: result.lng } : null;
  });
  const points: (Point | null)[] = located.map((at) => (at === null ? null : project(at.lat, at.lng)));
  // Points are rebuilt every render; the key changes only when a place moves or arrives.
  const pointsKey = JSON.stringify(points);
  const latestPoints = useRef(points);
  latestPoints.current = points;
  const lookupsOff = [...lookups.values()].some((result) => !result.ok && result.off === true);
  const off = webOff || lookupsOff;

  const groups = groupByDay(places);
  const days = groups.some((group) => group.label !== null);
  /** Place indexes in the order they're numbered, listed and toured: day by day. */
  const order = groups.flatMap((group) => group.places);
  const position = new Map(order.map((index, at) => [index, at]));
  const groupOf = new Map(groups.flatMap((group, at) => group.places.map((index) => [index, at] as const)));
  const tour = useTour(props.tour === true && !off, order.length, viewport);
  /** Whether place `index`'s pin is down (always, without a tour). */
  const dropped = (index: number) => (position.get(index) ?? Infinity) < tour.shown;

  useLayoutEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize((previous) =>
        previous !== null && previous.width === rect.width && previous.height === rect.height ? previous : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [off]);

  const fit = useCallback(
    (at: Size): View => {
      const shown = latestPoints.current.filter((point) => point !== null);
      return fitView(shown, at, PADDING, shown.length === 1 ? SINGLE_PLACE_ZOOM : FIT_MAX_ZOOM);
    },
    // Refit when the places change; they are read through the ref.
    [pointsKey],
  );

  // Until the user moves the map, it keeps fitting the places as they arrive.
  useEffect(() => {
    if (size === null || moved.current) return;
    setView(fit(size));
  }, [size, fit]);

  const stopAnimation = () => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
  };

  /** Glides to `target` (jumps under reduced motion). */
  const animateTo = useCallback(
    (target: View) => {
      stopAnimation();
      if (view === null || reducedMotion()) {
        setView(target);
        return;
      }
      const from = view;
      // Travel across the antimeridian the short way.
      const dx = target.x - from.x - Math.round(target.x - from.x);
      const started = performance.now();
      const frame = (now: number) => {
        const t = Math.min(1, (now - started) / 320);
        const ease = 1 - (1 - t) ** 3;
        setView({ x: from.x + dx * ease, y: from.y + (target.y - from.y) * ease, zoom: from.zoom + (target.zoom - from.zoom) * ease });
        animation.current = t < 1 ? requestAnimationFrame(frame) : null;
      };
      animation.current = requestAnimationFrame(frame);
    },
    [view],
  );

  useEffect(() => stopAnimation, []);

  // ctrl/⌘ + wheel (and trackpad pinch, which arrives as ctrl + wheel) zooms; a plain wheel scrolls the page.
  useEffect(() => {
    const element = viewport.current;
    if (element === null || size === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      stopAnimation();
      moved.current = true;
      const rect = element.getBoundingClientRect();
      const anchor = { left: event.clientX - rect.left, top: event.clientY - rect.top };
      setView((current) => (current === null ? current : zoomAround(current, current.zoom - event.deltaY * 0.01, anchor, size)));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [size]);

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = viewport.current?.getBoundingClientRect();
    return { left: event.clientX - (rect?.left ?? 0), top: event.clientY - (rect?.top ?? 0) };
  };

  const startPinch = (current: View) => {
    const [a, b] = [...pointers.current.values()];
    const rect = viewport.current?.getBoundingClientRect();
    gesture.current = {
      kind: "pinch",
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mid: { left: (a.x + b.x) / 2 - (rect?.left ?? 0), top: (a.y + b.y) / 2 - (rect?.top ?? 0) },
      view: current,
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (view === null || (event.pointerType === "mouse" && event.button !== 0)) return;
    stopAnimation();
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      event.currentTarget.setPointerCapture(event.pointerId);
      for (const id of pointers.current.keys()) if (!event.currentTarget.hasPointerCapture(id)) event.currentTarget.setPointerCapture(id);
      startPinch(view);
    } else if (pointers.current.size === 1) {
      gesture.current = { kind: "press", id: event.pointerId, x: event.clientX, y: event.clientY, view };
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || size === null) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = gesture.current;
    if (current === null) return;
    if (current.kind === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const rect = viewport.current?.getBoundingClientRect();
      const mid = { left: (a.x + b.x) / 2 - (rect?.left ?? 0), top: (a.y + b.y) / 2 - (rect?.top ?? 0) };
      const zoomed = zoomAround(current.view, current.view.zoom + Math.log2(distance / current.distance), current.mid, size);
      setView(pan(zoomed, mid.left - current.mid.left, mid.top - current.mid.top, size));
      moved.current = true;
      return;
    }
    if (current.kind === "pinch" || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.kind === "press") {
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { ...current, kind: "drag" };
    }
    moved.current = true;
    setView(pan(current.view, dx, dy, size));
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 1 && view !== null) {
      // One finger lifted from a pinch: carry on as a drag from here.
      const [[id, at]] = [...pointers.current.entries()];
      gesture.current = { kind: "drag", id, x: at.x, y: at.y, view };
    } else if (pointers.current.size === 0) {
      gesture.current = null;
    }
  };

  const zoomBy = (by: number) => {
    if (view === null || size === null) return;
    moved.current = true;
    animateTo(zoomAround(view, Math.round(view.zoom) + by, { left: size.width / 2, top: size.height / 2 }, size));
  };

  const showAll = () => {
    if (size === null) return;
    moved.current = false;
    animateTo(fit(size));
  };

  const select = (index: number) => {
    setSelected(index);
    const at = position.get(index);
    if (tour.active && at !== undefined) tour.seek(at);
  };

  const focusPlace = (index: number) => {
    const point = points[index];
    select(index);
    if (point === null || size === null || view === null) return;
    moved.current = true;
    animateTo(clampView({ x: point.x, y: point.y, zoom: Math.max(view.zoom, 12) }, size));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (view === null || size === null || event.target !== event.currentTarget) return;
    const step = 80;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (Object.hasOwn(moves, event.key)) {
      event.preventDefault();
      moved.current = true;
      animateTo(pan(view, moves[event.key][0], moves[event.key][1], size));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(1);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomBy(-1);
    } else if (event.key === "0") {
      event.preventDefault();
      showAll();
    }
  };

  const z = view === null ? null : tileZoom(view);
  const tiles = view === null || size === null ? [] : visibleTiles(view, size);
  // Remember the level once its tiles are all on the page, for the next zoom's backdrop.
  useEffect(() => {
    if (z === null || tiles.length === 0) return;
    if (tiles.every((tile) => cachedTile(tile.z, tile.x, tile.y) !== null)) setBackdropZ(z);
  });
  const onWebOff = useCallback(() => setWebOff(true), []);

  if (items.length === 0) return <ErrorLine message="Map needs places: {name, lat?, lng?, note?, day?, wiki?}" />;
  const unnamed = places.findIndex((place, index) => place === null && index < places.length - 1);
  const active = hovered ?? selected;
  const count = order.length;
  const number = (index: number) => (position.get(index) ?? 0) + 1;
  const color = (index: number) => dayColor(groupOf.get(index) ?? 0);
  const screen = view === null || size === null ? [] : points.map((point) => (point === null ? null : toScreen(point, view, size)));
  // One line per day, through the stops whose pins are down, in order.
  const routes = route
    ? groups.flatMap((group, at) => {
        const stops = group.places.flatMap((index) => (dropped(index) ? (screen[index] ?? []) : []));
        return stops.length < 2 ? [] : [{ key: at, color: dayColor(at), points: stops.map((stop) => `${stop.left.toFixed(1)},${stop.top.toFixed(1)}`).join(" ") }];
      })
    : [];
  // The pin that just dropped plays its fall when it mounts; one remounted later by a pan doesn't.
  const dropping = tour.active && performance.now() - tour.droppedAt < DROP_MS ? order[tour.shown - 1] : undefined;
  const tileFilter = dark ? "invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.88) saturate(0.6)" : undefined;

  return (
    // Tiles are not pictures to preview: keep image-preview plugins off them.
    <div ref={rise} data-bb-image-preview-ignore="" className="@container min-w-0">
      {unnamed === -1 ? null : <ErrorLine message={`Map place ${unnamed + 1} needs a name`} />}
      <div className={cn("flex min-w-0 flex-col gap-3", !off && "@xl:flex-row @xl:items-start")}>
        {off ? (
          <div className="@xl:flex-1">
            <WebOffLine what="Map" />
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-1.5 @xl:flex-1">
            <div
              ref={viewport}
              role="region"
              aria-roledescription="map"
              aria-label={`Map of ${count} ${count === 1 ? "place" : "places"}. Arrow keys pan, plus and minus zoom, 0 shows every place.`}
              tabIndex={0}
              onKeyDown={onKeyDown}
              {...NO_BB_SWIPE}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              onDoubleClick={(event) => {
                if (view === null || size === null || event.target !== event.currentTarget) return;
                moved.current = true;
                animateTo(zoomAround(view, Math.round(view.zoom) + 1, local(event), size));
              }}
              className="relative h-64 min-w-0 cursor-grab touch-none select-none overflow-hidden rounded-lg border border-border bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing @md:h-80 @xl:h-[22rem]"
            >
              <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" style={{ filter: tileFilter }}>
                {view !== null && size !== null && backdropZ !== null && backdropZ !== z && Math.abs(backdropZ - (z ?? 0)) <= 2 ? (
                  <Backdrop view={view} size={size} z={backdropZ} />
                ) : null}
                {tiles.map((tile) => (
                  <MapTile key={tile.key} z={tile.z} x={tile.x} y={tile.y} left={tile.left} top={tile.top} size={tile.size} onOff={onWebOff} />
                ))}
              </div>
              {routes.length === 0 ? null : (
                <svg aria-hidden className="pointer-events-none absolute inset-0 size-full">
                  {routes.map((line) => (
                    <g key={line.key}>
                      <polyline points={line.points} fill="none" stroke="var(--background)" strokeWidth={6} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
                      <polyline points={line.points} fill="none" stroke={line.color} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
                    </g>
                  ))}
                </svg>
              )}
              {screen.map((at, index) => {
                const place = places[index];
                if (at === null || place === null || size === null || !dropped(index)) return null;
                if (at.left < -20 || at.top < -20 || at.left > size.width + 20 || at.top > size.height + 20) return null;
                const on = active === index;
                return (
                  // The wrapper carries the position and the drop, so neither fights the pin's own centring and scale.
                  <div
                    key={`${index}-${tour.epoch}`}
                    ref={dropIn}
                    data-drop={dropping === index ? "true" : undefined}
                    className={cn("absolute", on && "z-10")}
                    style={{ left: at.left, top: at.top }}
                  >
                    <button
                      type="button"
                      aria-label={`${number(index)}. ${place.name}${place.day === null ? "" : `, ${place.day}`}`}
                      aria-pressed={selected === index}
                      onClick={() => {
                        select(index);
                        listRef.current?.querySelector(`[data-place="${index}"]`)?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
                      }}
                      onPointerEnter={() => setHovered(index)}
                      onPointerLeave={() => setHovered(null)}
                      onFocus={() => setHovered(index)}
                      onBlur={() => setHovered(null)}
                      className={cn(
                        MARKER,
                        "absolute left-0 top-0 size-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer text-[11px] shadow-[0_1px_3px_rgb(0_0_0/0.35)] ring-2 ring-background transition-transform duration-150 focus-visible:outline-none motion-reduce:transition-none",
                        on ? "scale-125 ring-[3px]" : "hover:scale-110",
                      )}
                      style={{ background: color(index) }}
                    >
                      {number(index)}
                    </button>
                  </div>
                );
              })}
              <div className="absolute right-2 top-2 flex flex-col overflow-hidden rounded-md border border-border shadow-[0_1px_2px_rgb(0_0_0/0.08)]">
                <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1)} disabled={view !== null && view.zoom >= MAX_ZOOM} className={CONTROL}>
                  <Icon name="Plus" className="size-4" />
                </button>
                <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(-1)} className={cn(CONTROL, "border-y border-border")}>
                  <Icon name="Minus" className="size-4" />
                </button>
                <button type="button" aria-label="Show every place" title="Show every place" onClick={showAll} className={CONTROL}>
                  <Icon name="Maximize2" className="size-4" />
                </button>
              </div>
              {tour.active && tour.started ? (
                <div className="absolute bottom-2 left-2 flex overflow-hidden rounded-md border border-border shadow-[0_1px_2px_rgb(0_0_0/0.08)]">
                  {tour.done ? null : (
                    <button type="button" aria-label={tour.paused ? "Resume the tour" : "Pause the tour"} onClick={tour.toggle} className={cn(TOUR_BUTTON, "border-r border-border")}>
                      <Icon name={tour.paused ? "Play" : "Pause"} aria-hidden className="size-3.5" />
                      {tour.paused ? "Resume" : "Pause"}
                    </button>
                  )}
                  <button type="button" aria-label="Replay the tour" onClick={tour.replay} className={TOUR_BUTTON}>
                    <Icon name="RotateCcw" aria-hidden className="size-3.5" />
                    Replay
                  </button>
                </div>
              ) : null}
              <p className="absolute bottom-0 right-0 m-0 rounded-tl-md bg-background/85 px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground">
                ©{" "}
                <UrlLink href="https://www.openstreetmap.org/copyright" className="underline-offset-2 hover:text-foreground hover:underline">
                  OpenStreetMap
                </UrlLink>{" "}
                contributors
              </p>
            </div>
            {days || routes.length > 0 ? (
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-0.5 text-[11px] leading-4 text-muted-foreground">
                {days ? (
                  <ul aria-label="Days" className="m-0 flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0">
                    {groups.map((group, at) =>
                      group.label === null ? null : (
                        <li key={at} className="flex items-center gap-1.5">
                          <span aria-hidden className="size-2 rounded-full" style={{ background: dayColor(at) }} />
                          {group.label}
                        </li>
                      ),
                    )}
                  </ul>
                ) : null}
                {routes.length === 0 ? null : (
                  <span>{routes.length === 1 ? "The line joins the stops in order; it isn't directions." : "Each line joins a day's stops in order; they aren't directions."}</span>
                )}
              </div>
            ) : null}
          </div>
        )}
        <div ref={listRef} className={cn("flex min-w-0 flex-col gap-2", !off && "@xl:max-h-[22rem] @xl:w-60 @xl:shrink-0 @xl:overflow-y-auto")}>
          {groups.map((group, at) => (
            <section key={at} aria-label={group.label ?? undefined} className="flex min-w-0 flex-col gap-0.5">
              {group.label === null ? null : (
                <h4 className="m-0 flex items-center gap-1.5 px-2 pt-0.5 text-[11px] font-medium uppercase leading-4 tracking-wide text-muted-foreground">
                  <span aria-hidden className="size-2 rounded-full" style={{ background: dayColor(at) }} />
                  {group.label}
                </h4>
              )}
              <ol start={number(group.places[0])} className="m-0 flex min-w-0 list-none flex-col gap-0.5 p-0">
                {group.places.map((index) => {
                  const place = places[index]!;
                  const result = place.given === null ? lookups.get(lookupKey(place.name)) : undefined;
                  // The backend says "couldn't find …" for a real miss; anything else is the lookup failing.
                  const status =
                    place.given !== null || result?.ok
                      ? null
                      : result === undefined
                        ? off
                          ? null
                          : "Locating…"
                        : result.off === true
                          ? null
                          : result.error.startsWith("couldn't find")
                            ? "Not found on the map"
                            : "Couldn't look this place up";
                  const on = active === index;
                  return (
                    <li key={index} data-place={index}>
                      <button
                        type="button"
                        aria-pressed={selected === index}
                        onClick={() => focusPlace(index)}
                        onPointerEnter={() => setHovered(index)}
                        onPointerLeave={() => setHovered(null)}
                        onFocus={() => setHovered(index)}
                        onBlur={() => setHovered(null)}
                        className={cn(
                          "flex w-full min-w-0 cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                          on ? "bg-surface-recessed" : "hover:bg-surface-recessed",
                        )}
                      >
                        <span
                          className={cn(MARKER, "mt-px size-5 text-[10px] transition-opacity", (points[index] === null || !dropped(index)) && "opacity-45")}
                          style={{ background: color(index) }}
                        >
                          {number(index)}
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-sm font-medium leading-5 text-foreground [overflow-wrap:anywhere]">{place.name}</span>
                          {place.note === null ? null : <span className="text-xs leading-4 text-muted-foreground">{place.note}</span>}
                          {status === null ? null : (
                            <span className={cn("text-[11px] leading-4 text-muted-foreground", status === "Locating…" && "animate-pulse motion-reduce:animate-none")}>{status}</span>
                          )}
                        </span>
                      </button>
                      {place.wiki === null || off ? null : <PlacePhoto title={place.wiki} name={place.name} onOff={onWebOff} />}
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
