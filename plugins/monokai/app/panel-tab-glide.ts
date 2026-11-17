import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

/**
 * Slides the active highlight from the old tab to the new one when the user
 * taps or clicks a tab in the right panel's toolbar: the desktop toolbar
 * (pinned views beside the scrolling tab strip) and the phone pager (pinned
 * circles beside a one-chip viewport).
 *
 * bb paints the active tab's fill on its `[data-tab-pill]` and flips
 * `aria-pressed` on the pill's button in place as the selection moves. When a
 * flip follows a pointer in the same toolbar, and the toolbar still holds the
 * pill that was active, the script lays a transient highlight
 * (`[data-monokai-tab-glide]`) over the toolbar and animates its `clip-path`
 * from the old pill's fill to the new one's. The new pill's own fill is hidden
 * during the flight (`[data-monokai-tab-glide-target]`) and returns when it lands.
 *
 * On the phone, bb steps the pager's chip row with an inline `translateX`,
 * resizes its viewport to the chip, and hides the chip it leaves. During the
 * flight the row slides from its old offset, the viewport eases to its new
 * width, and the chip leaving stays visible, so a swipe reads as the labels
 * moving under one fill.
 *
 * - **Pointer only:** a keyboard shortcut, a new tab, or a closed tab switches
 *   instantly. Tab shortcuts fire many times a day; motion there reads as lag.
 * - **Interruption:** a switch mid-flight starts from where the highlight is.
 * - **Reduced motion:** no slide.
 * - **Private contracts:** the `[data-sidebar-split-tab-group]` toolbar (one per
 *   split pane) and its `[data-secondary-panel-tab-scroll-region]`; the phone's
 *   `mobile-panel-tab-pager`, its `mobile-panel-tab-viewport`, the viewport's
 *   inline `width`, its row's inline `transform`, and each chip wrapper's inline
 *   `visibility`; `[data-tab-pill] > button[aria-pressed]`; and the active
 *   pill's computed fill (background colour, clip box, radius).
 */
const GROUP = "[data-sidebar-split-tab-group]";
const PAGER = '[data-testid="mobile-panel-tab-pager"]';
const VIEWPORT_ID = "mobile-panel-tab-viewport";
const VIEWPORT = `[data-testid="${VIEWPORT_ID}"]`;
const TOOLBAR = `${GROUP}, ${PAGER}`;
/** Regions that clip the pills inside them. */
const CLIP = `[data-secondary-panel-tab-scroll-region], ${VIEWPORT}`;
const PILL = "[data-tab-pill]";
const PILL_BUTTON = `:is(${TOOLBAR}) ${PILL} > button[aria-pressed]`;
const GLIDE = "data-monokai-tab-glide";
const TARGET = "data-monokai-tab-glide-target";
const HOST = "data-monokai-tab-glide-host";
const STYLE = "data-monokai-tab-glide-style";

/** On-screen movement, fired tens of times a day: fast, strong ease-in-out. */
const DURATION_MS = 200;
const EASING = "cubic-bezier(0.77, 0, 0.175, 1)";
/** Clears a flight whose `finished` never settles, as when bb removes the toolbar. */
const FALLBACK_MS = DURATION_MS + 120;
/** A switch this soon after a pointer event in its toolbar came from that pointer. */
const POINTER_WINDOW_MS = 800;

// The highlight is the toolbar's last child, a span, so bb's and the theme's
// `> div:first-child` rules keep matching the pinned views. The toolbar isolates
// during a flight so the highlight sits under the pills but over its own fill.
const CSS = `
${GROUP}[${HOST}], ${PAGER}[${HOST}] { position: relative; isolation: isolate; }
[${HOST}] > [${GLIDE}] { position: absolute; inset: 0; z-index: -1; pointer-events: none; }
[${HOST}] ${PILL}[${TARGET}] { background-color: transparent !important; }
`;

interface Flight {
  ghost: HTMLElement;
  from: Element;
  target: Element;
  animations: Animation[];
  timer: number;
}

interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Span {
  left: number;
  right: number;
}

/** A box as a `clip-path` inset from the edges of `host`. */
const insetOf = (box: Box, host: Box, radius: string) =>
  `inset(${box.top - host.top}px ${host.right - box.right}px ${host.bottom - box.bottom}px ${
    box.left - host.left
  }px round ${radius})`;

/** The box a highlight in flight covers now, from its computed `inset(…)`. */
function boxOfInset(clipPath: string, host: Box): Box | null {
  const match = /^inset\(([^)]*?)(?:\s+round\b|\))/.exec(clipPath);
  if (match === null) return null;
  const values = match[1]!.trim().split(/\s+/).map(Number.parseFloat);
  if (values.length === 0 || values.some(Number.isNaN)) return null;
  const [top, right = top, bottom = top, left = right] = values as [number, ...number[]];
  return {
    top: host.top + top,
    right: host.right - right,
    bottom: host.bottom - bottom,
    left: host.left + left,
  };
}

/** The x of a `translateX(…px)` in an inline style, or 0. */
const translateXOf = (style: string | null) =>
  Number(/translateX\(\s*(-?[\d.]+)px\s*\)/.exec(style ?? "")?.[1] ?? 0);

/** The x translation of a computed `transform`: `none`, `matrix(…)`, or `matrix3d(…)`. */
function computedTranslateX(transform: string) {
  const values = /^matrix(3d)?\(([^)]*)\)/.exec(transform);
  if (values === null) return translateXOf(transform);
  return Number.parseFloat(values[2]!.split(",")[values[1] === undefined ? 4 : 12] ?? "0") || 0;
}

/** The `width: …px` of an inline style, or null. */
const widthOf = (style: string | null) => {
  const match = /(?:^|;)\s*width:\s*([\d.]+)px/.exec(style ?? "");
  return match === null ? null : Number(match[1]);
};

/** A box limited to the horizontal span of the region clipping it. */
function clipTo(box: Box, region: Span | null): Box {
  if (region === null) return box;
  const left = Math.min(Math.max(box.left, region.left), region.right);
  const right = Math.max(Math.min(box.right, region.right), left);
  return { ...box, left, right };
}

/** Where a pill's fill paints: its border box, inset to its background clip. */
function fillOf(pill: Element, computed: CSSStyleDeclaration): Box {
  const { top, right, bottom, left } = pill.getBoundingClientRect();
  if (computed.backgroundClip === "border-box" || computed.backgroundClip === "") {
    return { top, right, bottom, left };
  }
  const content = computed.backgroundClip === "content-box";
  const side = (edge: string) =>
    (Number.parseFloat(computed.getPropertyValue(`border-${edge}-width`)) || 0) +
    (content ? Number.parseFloat(computed.getPropertyValue(`padding-${edge}`)) || 0 : 0);
  return {
    top: top + side("top"),
    right: right - side("right"),
    bottom: bottom - side("bottom"),
    left: left + side("left"),
  };
}

const glideAnimation = (element: Element) =>
  element.getAnimations?.().find((animation) => animation.id === GLIDE);

/** The phone pager's row and viewport, now and before bb last stepped them. */
interface PagerStep {
  viewport: HTMLElement;
  viewportRect: DOMRect;
  row: HTMLElement | null;
  /** Where the row is drawn now, mid-glide included. */
  rowNow: number;
  rowStart: number;
  rowEnd: number;
  widthStart: number | null;
  widthEnd: number | null;
}

/**
 * Where a pager's row and viewport start from: the running glide's current
 * value, the old inline style bb replaced this frame, or where they are.
 */
function pagerStep(
  toolbar: Element,
  oldStyles: ReadonlyMap<Element, string | null>,
  win: Window,
): PagerStep | null {
  const viewport = toolbar.querySelector<HTMLElement>(VIEWPORT);
  if (viewport === null) return null;
  const viewportRect = viewport.getBoundingClientRect();
  const child = viewport.firstElementChild;
  const row = child instanceof HTMLElement ? child : null;
  const rowEnd = translateXOf(row?.getAttribute("style") ?? null);
  const rowNow = row === null ? 0 : computedTranslateX(win.getComputedStyle(row).transform);
  let rowStart = rowEnd;
  if (row !== null && glideAnimation(row) !== undefined) {
    rowStart = rowNow;
  } else if (row !== null && oldStyles.has(row)) {
    rowStart = translateXOf(oldStyles.get(row) ?? null);
  }
  const widthEnd = widthOf(viewport.getAttribute("style"));
  let widthStart = widthEnd;
  if (glideAnimation(viewport) !== undefined) widthStart = viewportRect.width;
  else if (oldStyles.has(viewport)) widthStart = widthOf(oldStyles.get(viewport) ?? null);
  return { viewport, viewportRect, row, rowNow, rowStart, rowEnd, widthStart, widthEnd };
}

/**
 * A pill's fill, clipped to its region. In the pager, `at` places it as the row
 * and viewport stood before bb stepped them ("start") or where they come to rest
 * ("end"), whatever a running glide draws now.
 */
function boxOf(pill: Element, step: PagerStep | null, at: "start" | "end", win: Window): Box {
  const region = pill.closest(CLIP);
  const fill = fillOf(pill, win.getComputedStyle(pill));
  if (step === null || region !== step.viewport) {
    return clipTo(fill, region?.getBoundingClientRect() ?? null);
  }
  const shift = (at === "start" ? step.rowStart : step.rowEnd) - step.rowNow;
  const width = (at === "start" ? step.widthStart : step.widthEnd) ?? step.viewportRect.width;
  const { left } = step.viewportRect;
  return clipTo(
    { ...fill, left: fill.left + shift, right: fill.right + shift },
    { left, right: left + width },
  );
}

/** Slides the pager's row and eases its viewport from where they were. */
function animatePager(step: PagerStep, from: Element, timing: KeyframeAnimationOptions) {
  const animations: Animation[] = [];
  const { row, rowStart, rowEnd, viewport, widthStart, widthEnd } = step;
  if (row !== null && rowStart !== rowEnd) {
    animations.push(
      row.animate(
        [{ transform: `translateX(${rowStart}px)` }, { transform: `translateX(${rowEnd}px)` }],
        timing,
      ),
    );
    // bb hides the chip it leaves at once; keep it on screen while it slides out.
    const leaving = from.parentElement;
    if (leaving?.parentElement === row && leaving.style.visibility === "hidden") {
      animations.push(
        leaving.animate([{ visibility: "visible" }, { visibility: "visible" }], timing),
      );
    }
  }
  if (widthStart !== null && widthEnd !== null && widthStart !== widthEnd) {
    // The header row relayouts for the flight so the new-tab button moves with the chip.
    animations.push(
      viewport.animate([{ width: `${widthStart}px` }, { width: `${widthEnd}px` }], timing),
    );
  }
  return animations;
}

const pagerOf = (element: HTMLElement) => {
  if (element.dataset.testid === VIEWPORT_ID) return element.parentElement?.closest(PAGER) ?? null;
  if (element.parentElement?.dataset.testid === VIEWPORT_ID) return element.closest(PAGER);
  return null;
};

export function mountPanelTabGlide({
  signal,
  document: doc = document,
  isPointerSwitch,
  reducedMotion,
}: Pick<PluginContentScriptContext, "signal"> & {
  document?: Document;
  isPointerSwitch?: (pill: Element) => boolean;
  reducedMotion?: () => boolean;
}) {
  const view = doc.defaultView;
  if (signal.aborted || view === null) return () => {};
  const win: Window = view;
  const prefersReduced =
    reducedMotion ?? (() => win.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);

  // The last pointer event inside a toolbar: a tap, a click, or the end of a swipe.
  let pointer: { toolbar: Element; at: number } | null = null;
  const onPointer = (event: PointerEvent) => {
    const toolbar = event.target instanceof Element ? event.target.closest(TOOLBAR) : null;
    if (toolbar !== null) pointer = { toolbar, at: win.performance.now() };
  };
  const fromPointer =
    isPointerSwitch ??
    ((pill: Element) =>
      pointer !== null &&
      pill.closest(TOOLBAR) === pointer.toolbar &&
      win.performance.now() - pointer.at < POINTER_WINDOW_MS);

  const style = doc.createElement("style");
  style.setAttribute(STYLE, "");
  style.textContent = CSS;
  doc.head.append(style);

  const flights = new Map<Element, Flight>();
  let switches: { from: Element; to: Element }[] = [];
  /** Pagers bb stepped this frame. */
  const stepped = new Set<Element>();
  /** The first old inline style this frame of each pager viewport and row. */
  const oldStyles = new Map<Element, string | null>();
  let frame: number | undefined;

  function land(toolbar: Element) {
    const flight = flights.get(toolbar);
    if (flight === undefined) return;
    flights.delete(toolbar);
    win.clearTimeout(flight.timer);
    for (const animation of flight.animations) animation.cancel();
    flight.ghost.remove();
    flight.target.removeAttribute(TARGET);
    toolbar.removeAttribute(HOST);
  }

  /** `retarget`: bb moved the pills of a flight in progress, so follow them. */
  function glide(from: Element, to: Element, retarget = false) {
    const toolbar = to.closest(TOOLBAR);
    if (toolbar === null || from.closest(TOOLBAR) !== toolbar || !from.isConnected) return;
    if (!retarget && (prefersReduced() || !fromPointer(to))) {
      land(toolbar);
      return;
    }

    const host = toolbar.getBoundingClientRect();
    const toComputed = win.getComputedStyle(to);
    const step = pagerStep(toolbar, oldStyles, win);
    const end = boxOf(to, step, "end", win);
    const previous = flights.get(toolbar);
    const current =
      previous?.ghost.isConnected === true
        ? boxOfInset(win.getComputedStyle(previous.ghost).clipPath, host)
        : null;
    const start = current ?? boxOf(from, step, "start", win);
    const background = previous?.ghost.style.backgroundColor || toComputed.backgroundColor;
    const radius = toComputed.borderTopLeftRadius || "0px";
    land(toolbar);

    const ghost = doc.createElement("span");
    if (typeof ghost.animate !== "function") return;
    ghost.setAttribute(GLIDE, "");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.backgroundColor = background;
    ghost.style.clipPath = insetOf(end, host, radius);
    toolbar.setAttribute(HOST, "");
    toolbar.append(ghost);
    to.setAttribute(TARGET, "");

    const timing: KeyframeAnimationOptions = { duration: DURATION_MS, easing: EASING, id: GLIDE };
    const animations = [
      ghost.animate(
        [{ clipPath: insetOf(start, host, radius) }, { clipPath: insetOf(end, host, radius) }],
        timing,
      ),
      ...(step === null ? [] : animatePager(step, from, timing)),
    ];
    const flight: Flight = {
      ghost,
      from,
      target: to,
      animations,
      timer: win.setTimeout(() => land(toolbar), FALLBACK_MS),
    };
    flights.set(toolbar, flight);
    animations[0]!.finished.then(
      () => {
        if (flights.get(toolbar) === flight) land(toolbar);
        return undefined;
      },
      () => undefined,
    );
  }

  const run = () => {
    frame = undefined;
    const batch = switches;
    switches = [];
    for (const { from, to } of batch) {
      stepped.delete(to.closest(TOOLBAR) ?? to);
      glide(from, to);
    }
    // bb re-measures the pager a frame after a switch; a flight follows that step.
    for (const pager of stepped) {
      const flight = flights.get(pager);
      if (flight !== undefined) glide(flight.from, flight.target, true);
    }
    stepped.clear();
    oldStyles.clear();
  };

  /** Records a pager step's old inline style; the first this frame wins. */
  function readStep(target: HTMLElement, oldValue: string | null) {
    const pager = pagerOf(target);
    if (pager === null || oldValue === target.getAttribute("style")) return;
    if (!oldStyles.has(target)) oldStyles.set(target, oldValue);
    stepped.add(pager);
  }

  function readFlip(
    target: HTMLElement,
    oldValue: string | null,
    flips: Map<Element, Partial<Record<"from" | "to", Element>>>,
  ) {
    const pressed = target.getAttribute("aria-pressed");
    if (oldValue === pressed || !target.matches(PILL_BUTTON)) return;
    const pill = target.parentElement;
    const toolbar = pill?.closest(TOOLBAR);
    if (pill == null || toolbar == null) return;
    const entry = flips.get(toolbar) ?? {};
    if (pressed === "true") entry.to = pill;
    else if (oldValue === "true") entry.from = pill;
    flips.set(toolbar, entry);
  }

  const observer = new MutationObserver((records) => {
    // One switch flips two buttons in the same toolbar; split panes each have one.
    const flips = new Map<Element, Partial<Record<"from" | "to", Element>>>();
    for (const { target, attributeName, oldValue } of records) {
      if (!(target instanceof HTMLElement)) continue;
      if (attributeName === "style") readStep(target, oldValue);
      else readFlip(target, oldValue, flips);
    }
    for (const { from, to } of flips.values()) {
      if (from !== undefined && to !== undefined) switches.push({ from, to });
    }
    // Measure once, before the next paint, after bb's layout effects place the new tab.
    if (switches.length > 0 || stepped.size > 0) frame ??= win.requestAnimationFrame(run);
  });
  observer.observe(doc.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-pressed", "style"],
    attributeOldValue: true,
  });
  doc.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
  doc.addEventListener("pointerup", onPointer, { capture: true, passive: true });

  const dispose = () => {
    observer.disconnect();
    doc.removeEventListener("pointerdown", onPointer, true);
    doc.removeEventListener("pointerup", onPointer, true);
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    frame = undefined;
    switches = [];
    stepped.clear();
    oldStyles.clear();
    for (const toolbar of flights.keys()) land(toolbar);
    style.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
