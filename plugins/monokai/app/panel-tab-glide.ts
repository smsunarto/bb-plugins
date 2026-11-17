import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

/**
 * Slides the active highlight from the old tab to the new one when the user
 * clicks a tab in the right panel's desktop toolbar: the pinned views (thread
 * info, source control) and the scrolling tab strip beside them.
 *
 * bb paints the active tab's background on its `[data-tab-pill]` and flips
 * `aria-pressed` on the pill's button in place as the selection moves. When a
 * flip lands on a pill under the pointer, and the same toolbar still holds the
 * pill that was active, the script lays a transient highlight
 * (`[data-monokai-tab-glide]`) across the toolbar and animates its `clip-path`
 * from the old pill to the new one. The new pill's own background is hidden
 * during the flight (`[data-monokai-tab-glide-target]`) and returns when it lands.
 *
 * - **Pointer only:** a keyboard shortcut, a new tab, or a closed tab switches
 *   instantly. Tab shortcuts fire many times a day; motion there reads as lag.
 * - **Interruption:** a switch mid-flight starts from where the highlight is.
 * - **Reduced motion:** no slide.
 * - **Phone:** the pager (`mobile-panel-tab-pager`) shows one tab at a time and
 *   is left alone.
 * - **Private contracts:** the `[data-sidebar-split-tab-group]` toolbar, one per
 *   split pane; the strip's `[data-secondary-panel-tab-scroll-region]`, which
 *   clips a half-scrolled tab; `[data-tab-pill] > button[aria-pressed]`; and the
 *   active pill's computed background and radius. The highlight is the toolbar's
 *   first child, absolutely positioned under the positioned pills, and is
 *   removed when the flight ends.
 */
const GROUP = "[data-sidebar-split-tab-group]";
const SCROLL_REGION = "[data-secondary-panel-tab-scroll-region]";
const PAGER = '[data-testid="mobile-panel-tab-pager"]';
const PILL = "[data-tab-pill]";
const PILL_BUTTON = `${GROUP} ${PILL} > button[aria-pressed]`;
const GLIDE = "data-monokai-tab-glide";
const TARGET = "data-monokai-tab-glide-target";
const HOST = "data-monokai-tab-glide-host";
const STYLE = "data-monokai-tab-glide-style";

/** On-screen movement, fired tens of times a day: fast, strong ease-in-out. */
const DURATION_MS = 200;
const EASING = "cubic-bezier(0.77, 0, 0.175, 1)";
/** Clears a flight whose `finished` never settles, as when bb removes the toolbar. */
const FALLBACK_MS = DURATION_MS + 120;

const CSS = `
${GROUP}[${HOST}] { position: relative; }
${GROUP} > [${GLIDE}] { position: absolute; left: 0; right: 0; pointer-events: none; }
${GROUP} ${PILL}[${TARGET}] { background-color: transparent !important; }
`;

interface Flight {
  ghost: HTMLElement;
  target: Element;
  animation: Animation | null;
  timer: number;
}

interface Inset {
  left: number;
  right: number;
}

const insetOf = ({ left, right }: Inset, radius: string) =>
  `inset(0px ${right}px 0px ${left}px round ${radius})`;

/** The current `inset(top right bottom left …)` of a highlight in flight. */
function parseInset(clipPath: string): Inset | null {
  const match = /^inset\(\s*([-\d.]+)px\s+([-\d.]+)px\s+([-\d.]+)px\s+([-\d.]+)px/.exec(clipPath);
  if (match === null) return null;
  return { right: Number(match[2]), left: Number(match[4]) };
}

export function mountPanelTabGlide({
  signal,
  document: doc = document,
  isPointerSwitch = (pill: Element) => pill.matches(":hover"),
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

  const style = doc.createElement("style");
  style.setAttribute(STYLE, "");
  style.textContent = CSS;
  doc.head.append(style);

  const flights = new Map<Element, Flight>();
  let pending: { from: Element; to: Element }[] = [];
  let frame: number | undefined;

  function land(group: Element) {
    const flight = flights.get(group);
    if (flight === undefined) return;
    flights.delete(group);
    win.clearTimeout(flight.timer);
    flight.animation?.cancel();
    flight.ghost.remove();
    flight.target.removeAttribute(TARGET);
    group.removeAttribute(HOST);
  }

  /** A pill's horizontal extent, clipped to the strip's scroll region when it scrolls. */
  function extent(pill: Element): { left: number; right: number } {
    const rect = pill.getBoundingClientRect();
    const region = pill.closest(SCROLL_REGION);
    if (region === null) return rect;
    const bounds = region.getBoundingClientRect();
    return {
      left: Math.max(rect.left, bounds.left),
      right: Math.max(Math.min(rect.right, bounds.right), bounds.left),
    };
  }

  function glide(from: Element, to: Element) {
    const group = to.closest(GROUP);
    if (group === null || from.closest(GROUP) !== group || !from.isConnected) return;
    if (prefersReduced() || !isPointerSwitch(to)) {
      land(group);
      return;
    }

    const groupRect = group.getBoundingClientRect();
    const toRect = to.getBoundingClientRect();
    const toExtent = extent(to);
    const fromExtent = extent(from);
    const computed = win.getComputedStyle(to);
    const width = groupRect.width;
    const insetFrom = ({ left, right }: { left: number; right: number }): Inset => ({
      left: left - groupRect.left,
      right: width - (right - groupRect.left),
    });
    const end = insetFrom(toExtent);

    const previous = flights.get(group);
    let start = insetFrom(fromExtent);
    if (previous !== undefined && previous.ghost.isConnected) {
      start = parseInset(win.getComputedStyle(previous.ghost).clipPath) ?? start;
    }
    const background = previous?.ghost.style.backgroundColor || computed.backgroundColor;
    const radius = computed.borderTopLeftRadius || "0px";
    land(group);

    const ghost = doc.createElement("div");
    ghost.setAttribute(GLIDE, "");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.top = `${toRect.top - groupRect.top}px`;
    ghost.style.height = `${toRect.height}px`;
    ghost.style.backgroundColor = background;
    ghost.style.clipPath = insetOf(end, radius);
    if (typeof ghost.animate !== "function") return;
    group.setAttribute(HOST, "");
    group.prepend(ghost);
    to.setAttribute(TARGET, "");

    const animation = ghost.animate(
      [{ clipPath: insetOf(start, radius) }, { clipPath: insetOf(end, radius) }],
      { duration: DURATION_MS, easing: EASING },
    );
    const flight: Flight = {
      ghost,
      target: to,
      animation,
      timer: win.setTimeout(() => land(group), FALLBACK_MS),
    };
    flights.set(group, flight);
    animation.finished.then(
      () => {
        if (flights.get(group) === flight) land(group);
        return undefined;
      },
      () => undefined,
    );
  }

  const run = () => {
    frame = undefined;
    const batch = pending;
    pending = [];
    for (const { from, to } of batch) glide(from, to);
  };

  const observer = new MutationObserver((records) => {
    // One switch flips two buttons in the same toolbar; split panes each have one.
    const switches = new Map<Element, { from?: Element; to?: Element }>();
    for (const { target, oldValue } of records) {
      if (!(target instanceof Element) || !target.matches(PILL_BUTTON)) continue;
      const pressed = target.getAttribute("aria-pressed");
      if (oldValue === pressed) continue;
      const pill = target.parentElement;
      const group = pill?.closest(GROUP);
      if (pill == null || group == null || pill.closest(PAGER) !== null) continue;
      const entry = switches.get(group) ?? {};
      if (pressed === "true") entry.to = pill;
      else if (oldValue === "true") entry.from = pill;
      switches.set(group, entry);
    }
    for (const { from, to } of switches.values()) {
      if (from !== undefined && to !== undefined) pending.push({ from, to });
    }
    // Measure once, before the next paint, after bb's layout effects scroll the tab into view.
    if (pending.length > 0) frame ??= win.requestAnimationFrame(run);
  });
  observer.observe(doc.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-pressed"],
    attributeOldValue: true,
  });

  const dispose = () => {
    observer.disconnect();
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    frame = undefined;
    pending = [];
    for (const group of flights.keys()) land(group);
    style.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
