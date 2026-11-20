import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

/**
 * Slides the active highlight from the old tab to the new one when the user
 * taps, clicks, or swipes to a tab of the same size in the right panel's tab
 * pager: pinned circles beside a viewport of the chips that fit. bb shows the
 * pager in place of the toolbar whenever the window is 767px wide or narrower,
 * with a mouse or a finger.
 *
 * - **One size:** the highlight never changes width or shape in flight. It
 *   glides between tabs of one size, such as two pinned circles or two chips
 *   of one width, and only translates. A switch between sizes, such as a
 *   circle and a chip, is instant: a highlight stretching between them read as
 *   the tab expanding (BBP-49).
 * - **Desktop toolbar:** wider windows show bb's toolbar, which always switches
 *   instantly. Its icon and labeled tabs differ in width, and bb swaps the
 *   panel's content on the click's frame.
 *
 * bb paints the active tab's fill on its `[data-tab-pill]` and flips
 * `aria-pressed` on the pill's button in place as the selection moves. When a
 * flip follows a pointer in the same pager, and the pager still holds the
 * pill that was active, the script lays a transient highlight
 * (`[data-monokai-tab-glide]`) over the pager and animates its `clip-path`
 * from the old pill's fill to the new one's. The new pill's own fill is hidden
 * during the flight (`[data-monokai-tab-glide-target]`) and returns when it lands.
 *
 * bb steps the pager's chip row with an inline `translateX` and hides the chip
 * it leaves. During a flight between chips the row slides from its old offset
 * and the chip leaving stays visible, so a swipe reads as the labels moving
 * under one fill.
 *
 * - **Pointer only:** a keyboard shortcut, a new tab, or a closed tab switches
 *   instantly. Tab shortcuts fire many times a day; motion there reads as lag.
 * - **Interruption:** a switch mid-flight starts from where the highlight is.
 * - **Reduced motion:** no slide.
 * - **Private contracts:** `mobile-panel-tab-pager`, its
 *   `mobile-panel-tab-viewport`, its row's inline `transform`, and each chip
 *   wrapper's inline `visibility`; `[data-tab-pill] > button[aria-pressed]`;
 *   and the active pill's computed fill (background colour, clip box, radius).
 */
const PAGER = '[data-testid="mobile-panel-tab-pager"]';
const VIEWPORT_ID = "mobile-panel-tab-viewport";
const VIEWPORT = `[data-testid="${VIEWPORT_ID}"]`;
const PILL = "[data-tab-pill]";
const PILL_BUTTON = `${PAGER} ${PILL} > button[aria-pressed]`;
const GLIDE = "data-monokai-tab-glide";
const TARGET = "data-monokai-tab-glide-target";
const HOST = "data-monokai-tab-glide-host";
const STYLE = "data-monokai-tab-glide-style";

/** On-screen movement, fired tens of times a day: fast, strong ease-in-out. */
const DURATION_MS = 200;
const EASING = "cubic-bezier(0.77, 0, 0.175, 1)";
/** Clears a flight whose `finished` never settles, as when bb removes the pager. */
const FALLBACK_MS = DURATION_MS + 120;
/** A switch this soon after a pointer event in its pager came from that pointer. */
const POINTER_WINDOW_MS = 800;

// The highlight is the pager's last child, a span, so bb's and the theme's
// `> div:first-child` rules keep matching the pinned views. The pager isolates
// during a flight so the highlight sits under the pills but over its own fill.
const CSS = `
${PAGER}[${HOST}] { position: relative; isolation: isolate; }
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

/** A box limited to the horizontal span of the viewport clipping it. */
function clipTo(box: Box, region: { left: number; right: number }): Box {
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

/**
 * Whether two boxes have one size. A flight between them only translates the
 * highlight; between sizes it would stretch, so the switch is instant.
 */
const sameSize = (a: Box, b: Box) =>
  Math.abs(a.right - a.left - (b.right - b.left)) < 0.5 &&
  Math.abs(a.bottom - a.top - (b.bottom - b.top)) < 0.5;

const glideAnimation = (element: Element) =>
  element.getAnimations?.().find((animation) => animation.id === GLIDE);

/** The pager's viewport, and its row now and before bb last stepped it. */
interface PagerStep {
  viewport: HTMLElement;
  viewportRect: DOMRect;
  row: HTMLElement | null;
  /** Where the row is drawn now, mid-glide included. */
  rowNow: number;
  rowStart: number;
  rowEnd: number;
}

/**
 * Where a pager's row starts from: the running glide's current value, the old
 * inline style bb replaced this frame, or where it is.
 */
function pagerStep(
  pager: Element,
  oldStyles: ReadonlyMap<Element, string | null>,
  win: Window,
): PagerStep | null {
  const viewport = pager.querySelector<HTMLElement>(VIEWPORT);
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
  return { viewport, viewportRect, row, rowNow, rowStart, rowEnd };
}

/**
 * Where a pill's fill is drawn. A pinned circle's is its own box. A chip's is
 * its own box placed as the row stood before bb stepped it ("start") or where
 * it comes to rest ("end"), whatever a running glide draws now, and clipped to
 * the viewport. The viewport shows every chip that fits, so the active chip
 * rests at its own slot, not at the viewport's left edge.
 */
function boxOf(pill: Element, fill: Box, step: PagerStep | null, at: "start" | "end"): Box {
  if (step === null || pill.closest(VIEWPORT) !== step.viewport) return fill;
  const shift = (at === "start" ? step.rowStart : step.rowEnd) - step.rowNow;
  const { left, right } = step.viewportRect;
  return clipTo({ ...fill, left: fill.left + shift, right: fill.right + shift }, { left, right });
}

/**
 * Slides the pager's row from where it was. A flight joins chips of one
 * size, so the viewport's width is left to bb.
 */
function animatePager(step: PagerStep, from: Element, timing: KeyframeAnimationOptions) {
  const { row, rowStart, rowEnd } = step;
  if (row === null || rowStart === rowEnd) return [];
  const animations = [
    row.animate(
      [{ transform: `translateX(${rowStart}px)` }, { transform: `translateX(${rowEnd}px)` }],
      timing,
    ),
  ];
  // bb hides the chip it leaves at once; keep it on screen while it slides out.
  const leaving = from.parentElement;
  if (leaving?.parentElement === row && leaving.style.visibility === "hidden") {
    animations.push(
      leaving.animate([{ visibility: "visible" }, { visibility: "visible" }], timing),
    );
  }
  return animations;
}

/** The pager whose chip row this is, or null. bb's other inline styles never move a flight. */
const pagerOfRow = (element: HTMLElement) =>
  element.parentElement?.dataset.testid === VIEWPORT_ID ? element.closest(PAGER) : null;

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

  // The last pointer event inside a pager: a tap, a click, or the end of a swipe.
  let pointer: { pager: Element; at: number } | null = null;
  const onPointer = (event: PointerEvent) => {
    const pager = event.target instanceof Element ? event.target.closest(PAGER) : null;
    if (pager !== null) pointer = { pager, at: win.performance.now() };
  };
  const fromPointer =
    isPointerSwitch ??
    ((pill: Element) =>
      pointer !== null &&
      pill.closest(PAGER) === pointer.pager &&
      win.performance.now() - pointer.at < POINTER_WINDOW_MS);

  const style = doc.createElement("style");
  style.setAttribute(STYLE, "");
  style.textContent = CSS;
  doc.head.append(style);

  const flights = new Map<Element, Flight>();
  let switches: { from: Element; to: Element }[] = [];
  /** Pagers bb stepped this frame. */
  const stepped = new Set<Element>();
  /** The first old inline style this frame of each pager's row. */
  const oldStyles = new Map<Element, string | null>();
  let frame: number | undefined;

  function land(pager: Element) {
    const flight = flights.get(pager);
    if (flight === undefined) return;
    flights.delete(pager);
    win.clearTimeout(flight.timer);
    for (const animation of flight.animations) animation.cancel();
    flight.ghost.remove();
    flight.target.removeAttribute(TARGET);
    pager.removeAttribute(HOST);
  }

  /** `retarget`: bb moved the pills of a flight in progress, so follow them. */
  function glide(from: Element, to: Element, retarget = false) {
    const pager = to.closest(PAGER);
    if (pager === null || from.closest(PAGER) !== pager || !from.isConnected) return;
    if (!retarget && (prefersReduced() || !fromPointer(to))) {
      land(pager);
      return;
    }

    const host = pager.getBoundingClientRect();
    const toComputed = win.getComputedStyle(to);
    const step = pagerStep(pager, oldStyles, win);
    const toFill = fillOf(to, toComputed);
    const fromFill = fillOf(from, win.getComputedStyle(from));
    const end = boxOf(to, toFill, step, "end");
    const previous = flights.get(pager);
    const current =
      previous?.ghost.isConnected === true
        ? boxOfInset(win.getComputedStyle(previous.ghost).clipPath, host)
        : null;
    const start = current ?? boxOf(from, fromFill, step, "start");
    // The highlight never changes size in flight: between sizes, switch instantly.
    // Compare the tabs themselves too: clipping a wide chip to the narrower
    // viewport bb has already resized would make two sizes look like one.
    if (!sameSize(fromFill, toFill) || !sameSize(start, end)) {
      land(pager);
      return;
    }
    const background = previous?.ghost.style.backgroundColor || toComputed.backgroundColor;
    const radius = toComputed.borderTopLeftRadius || "0px";
    land(pager);

    const ghost = doc.createElement("span");
    if (typeof ghost.animate !== "function") return;
    ghost.setAttribute(GLIDE, "");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.backgroundColor = background;
    ghost.style.clipPath = insetOf(end, host, radius);
    pager.setAttribute(HOST, "");
    pager.append(ghost);
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
      timer: win.setTimeout(() => land(pager), FALLBACK_MS),
    };
    flights.set(pager, flight);
    animations[0]!.finished.then(
      () => {
        if (flights.get(pager) === flight) land(pager);
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
      stepped.delete(to.closest(PAGER) ?? to);
      glide(from, to);
    }
    // bb can step the row a frame after a switch; a flight follows that step.
    for (const pager of stepped) {
      const flight = flights.get(pager);
      if (flight !== undefined) glide(flight.from, flight.target, true);
    }
    stepped.clear();
    oldStyles.clear();
  };

  /** Records a row step's old inline style; the first this frame wins. */
  function readStep(target: HTMLElement, oldValue: string | null) {
    const pager = pagerOfRow(target);
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
    const pager = pill?.closest(PAGER);
    if (pill == null || pager == null) return;
    const entry = flips.get(pager) ?? {};
    if (pressed === "true") entry.to = pill;
    else if (oldValue === "true") entry.from = pill;
    flips.set(pager, entry);
  }

  const observer = new MutationObserver((records) => {
    // One switch flips two buttons in the same pager.
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
    for (const pager of flights.keys()) land(pager);
    style.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
