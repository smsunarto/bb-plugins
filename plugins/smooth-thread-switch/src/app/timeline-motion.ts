import Lenis from "lenis";

const TIMELINE = "[data-thread-window] .thread-scrollbar";
const MANUAL_IDLE_MS = 250;
const RESTORE_SETTLE_MS = 250;
const RESTORE_ORIGIN_TOLERANCE = 32;

type Target = { kind: "bottom" } | { kind: "offset"; px: number };
type Restoration = { origin: number; until: number };
type Motion =
  | { kind: "idle" }
  | { kind: "animating"; target: Target; restoration: Restoration | null }
  | { kind: "manual"; until: number };
type TimelineSession = {
  element: HTMLElement;
  content: HTMLElement;
  lenis: Lenis;
  motion: Motion;
  previousMax: number;
  lastFrame: number;
  hasRequested: boolean;
  bottomPlacementUntil: number;
  originalClasses: string[];
};

function sameTarget(a: Target, b: Target): boolean {
  return a.kind === b.kind && (a.kind === "bottom" || (b.kind === "offset" && a.px === b.px));
}

function restorationFor(session: TimelineSession, target: Target, now: number): Restoration | null {
  if (session.motion.kind === "animating") return session.motion.restoration;
  if (session.hasRequested || target.kind === "bottom") return null;
  const origin = session.element.scrollTop;
  return Math.abs(target.px - origin) > RESTORE_ORIGIN_TOLERANCE
    ? { origin, until: now + RESTORE_SETTLE_MS }
    : null;
}

function isRestoreReplay(restoration: Restoration | null, target: Target, now: number): boolean {
  return (
    restoration !== null &&
    now < restoration.until &&
    target.kind === "offset" &&
    Math.abs(target.px - restoration.origin) <= RESTORE_ORIGIN_TOLERANCE
  );
}

function trackBottomPlacement(
  session: TimelineSession,
  target: Target,
  max: number,
  now: number,
): boolean {
  const initial =
    session.motion.kind === "idle" &&
    target.kind === "bottom" &&
    (!session.hasRequested || now < session.bottomPlacementUntil);
  // Mount-time footer and row measurements can revise the bottom over several frames.
  // Keep that placement synchronous, without extending the window on each correction.
  if (initial && !session.hasRequested && max > 0) {
    session.bottomPlacementUntil = now + RESTORE_SETTLE_MS;
  } else if (!initial) {
    session.bottomPlacementUntil = 0;
  }
  return initial;
}

function maximum(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function contentFor(element: Element): HTMLElement | null {
  if (!element.isConnected || !element.matches(TIMELINE)) return null;
  const content = element.firstElementChild;
  const HTMLElement = element.ownerDocument.defaultView?.HTMLElement;
  return HTMLElement &&
    content instanceof HTMLElement &&
    content.querySelector(":scope > .scroll-bottom-anchor")
    ? content
    : null;
}

function cancel(session: TimelineSession): void {
  session.lenis.stop();
  session.lenis.start();
}

function isScrollKey(event: KeyboardEvent, target: Element): boolean {
  return (
    !event.defaultPrevented &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
    !target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    ) &&
    !(event.key === " " && target.closest("button, a, [role=button]"))
  );
}

const noop = () => {};

export function mountTimelineMotion(document: Document, signal?: AbortSignal): () => void {
  const view = document.defaultView;
  if (!view || signal?.aborted) return noop;
  const prototype = view.Element.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "scrollTop");
  if (!original?.configurable || !original.get || !original.set) return noop;
  const nativeSet = original.set;
  const sessions = new Map<HTMLElement, TimelineSession>();
  const reducedMotion = view.matchMedia("(prefers-reduced-motion: reduce)");
  const styles = document.createElement("style");
  styles.dataset.smoothThreadScroll = "";
  styles.textContent = `${TIMELINE}, ${TIMELINE} * { overflow-anchor: none !important; }
    ${TIMELINE} { scroll-behavior: auto !important; }`;
  let disposed = false;
  let frame: number | null = null;

  function attach(element: HTMLElement, content: HTMLElement): TimelineSession {
    const existing = sessions.get(element);
    if (existing) return existing;
    const originalClasses = [...element.classList].filter((name) => name.startsWith("lenis"));
    const lenis = new Lenis({
      wrapper: element,
      content,
      autoRaf: false,
      autoResize: false,
      naiveDimensions: true,
      smoothWheel: false,
      syncTouch: false,
      virtualScroll: () => false,
      respectReducedMotion: false,
      lerp: 0.18,
    });
    const session: TimelineSession = {
      element,
      content,
      lenis,
      motion: { kind: "idle" },
      previousMax: maximum(element),
      lastFrame: 0,
      hasRequested: false,
      bottomPlacementUntil: 0,
      originalClasses,
    };
    sessions.set(element, session);
    return session;
  }

  function detach(session: TimelineSession): void {
    session.lenis.destroy();
    for (const name of session.originalClasses) session.element.classList.add(name);
    sessions.delete(session.element);
  }

  function requestFrame(): void {
    if (!disposed && frame === null) frame = view!.requestAnimationFrame(advance);
  }

  function advance(time: number): void {
    frame = null;
    for (const session of sessions.values()) {
      if (!session.element.isConnected) {
        detach(session);
        continue;
      }
      if (session.motion.kind !== "animating") continue;
      const max = maximum(session.element);
      const target = session.motion.target;
      const destination = target.kind === "bottom" ? max : Math.min(target.px, max);
      if (max < session.previousMax) {
        cancel(session);
        nativeSet.call(session.element, destination);
        session.motion = { kind: "idle" };
      } else {
        if (destination !== session.lenis.targetScroll) {
          session.lenis.scrollTo(destination, { programmatic: false, lerp: 0.18 });
        }
        const elapsed = Math.min(32, Math.max(0, time - session.lastFrame));
        session.lastFrame = time;
        session.lenis.raf(session.lenis.time + elapsed);
        if (!session.lenis.isScrolling) session.motion = { kind: "idle" };
      }
      session.previousMax = max;
      if (session.motion.kind === "animating") requestFrame();
    }
  }

  function routeWrite(element: HTMLElement, value: number, content: HTMLElement): void {
    const session = attach(element, content);
    const max = maximum(element);
    const destination = Math.max(0, Math.min(value, max));
    const target: Target =
      destination === max ? { kind: "bottom" } : { kind: "offset", px: destination };
    const current = element.scrollTop;
    const now = view!.performance.now();
    const restoration = restorationFor(session, target, now);
    const growth = max - session.previousMax;
    const prepend =
      session.hasRequested &&
      growth > 0 &&
      session.previousMax - current > 2 &&
      Math.abs(destination - current - growth) <= 1 &&
      target.kind === "offset";
    const initialBottomPlacement = trackBottomPlacement(session, target, max, now);
    session.hasRequested ||= max > 0;
    session.previousMax = max;
    if (!reducedMotion.matches && growth >= 0 && isRestoreReplay(restoration, target, now)) return;
    if (reducedMotion.matches || growth < 0 || prepend || initialBottomPlacement) {
      cancel(session);
      nativeSet.call(element, destination);
      session.motion = { kind: "idle" };
      return;
    }
    if (session.motion.kind === "manual") {
      if (view!.performance.now() < session.motion.until) return;
    }
    if (session.motion.kind === "animating" && sameTarget(session.motion.target, target)) {
      requestFrame();
      return;
    }
    cancel(session);
    if (Math.abs(destination - current) <= 1) {
      nativeSet.call(element, destination);
      session.motion = { kind: "idle" };
      return;
    }
    session.motion = { kind: "animating", target, restoration };
    session.lastFrame = view!.performance.now();
    session.lenis.raf(session.lastFrame);
    session.lenis.scrollTo(destination, { programmatic: false, lerp: 0.18 });
    requestFrame();
  }

  function routedSet(this: HTMLElement, value: unknown): void {
    const content =
      !disposed && typeof value === "number" && Number.isFinite(value) ? contentFor(this) : null;
    if (content) routeWrite(this, value as number, content);
    else nativeSet.call(this, value);
  }

  function interrupt(session: TimelineSession, held = false): void {
    session.bottomPlacementUntil = 0;
    cancel(session);
    session.motion = {
      kind: "manual",
      until: held ? Infinity : view!.performance.now() + MANUAL_IDLE_MS,
    };
  }

  function onInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof view!.Element)) return;
    if (event instanceof view!.KeyboardEvent) {
      if (!isScrollKey(event, target)) return;
      if (target === document.body || target === document.documentElement) {
        for (const session of sessions.values()) interrupt(session);
        return;
      }
    }
    const element = target.closest<HTMLElement>(TIMELINE);
    if (!element) return;
    const content = contentFor(element);
    if (!content) return;
    if (event.type === "pointerdown") {
      const bounds = element.getBoundingClientRect();
      if (event.target !== element || (event as PointerEvent).clientX < bounds.right - 16) return;
    }
    const session = attach(element, content);
    interrupt(
      session,
      event.type === "touchstart" || event.type === "touchmove" || event.type === "pointerdown",
    );
  }

  function onRelease(): void {
    for (const session of sessions.values()) {
      if (session.motion.kind === "manual" && session.motion.until === Infinity) {
        session.motion.until = view!.performance.now() + MANUAL_IDLE_MS;
      }
    }
  }

  function onBottomClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof view!.Element)) return;
    const button = target.closest('button[aria-label="Scroll to latest event"]');
    const threadWindow = button?.closest("[data-thread-window]");
    if (!threadWindow) return;
    // Let the host's click handler take over immediately, even during a gesture.
    // Automatic restore retries still respect the manual-input grace period.
    for (const session of sessions.values()) {
      if (
        session.motion.kind === "manual" &&
        session.element.closest("[data-thread-window]") === threadWindow
      ) {
        session.motion.until = 0;
      }
    }
  }

  function onReducedMotion(): void {
    if (!reducedMotion.matches) return;
    for (const session of sessions.values()) {
      const motion = session.motion;
      cancel(session);
      if (motion.kind === "animating") {
        nativeSet.call(
          session.element,
          motion.target.kind === "bottom" ? maximum(session.element) : motion.target.px,
        );
      }
      session.motion = { kind: "idle" };
    }
    if (frame !== null) view!.cancelAnimationFrame(frame);
    frame = null;
  }

  function discover(): void {
    for (const session of sessions.values()) {
      if (contentFor(session.element) !== session.content) detach(session);
    }
    for (const element of document.querySelectorAll<HTMLElement>(TIMELINE)) {
      const content = contentFor(element);
      if (content) attach(element, content);
    }
  }

  const observer = new view.MutationObserver(discover);
  const inputEvents = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"];
  const releaseEvents = ["touchend", "touchcancel", "pointerup", "pointercancel"];
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    if (frame !== null) view!.cancelAnimationFrame(frame);
    frame = null;
    for (const session of sessions.values()) detach(session);
    for (const type of inputEvents) document.removeEventListener(type, onInput, true);
    for (const type of releaseEvents) view!.removeEventListener(type, onRelease);
    document.removeEventListener("click", onBottomClick, true);
    reducedMotion.removeEventListener("change", onReducedMotion);
    signal?.removeEventListener("abort", dispose);
    styles.remove();
    const installed = Object.getOwnPropertyDescriptor(prototype, "scrollTop");
    if (installed?.set === routedSet && installed.get === original!.get) {
      Object.defineProperty(prototype, "scrollTop", original!);
    }
  }

  try {
    document.addEventListener("click", onBottomClick, { capture: true, passive: true });
    Object.defineProperty(prototype, "scrollTop", { ...original, set: routedSet });
    document.head.append(styles);
    for (const type of inputEvents)
      document.addEventListener(type, onInput, { capture: true, passive: true });
    for (const type of releaseEvents) view.addEventListener(type, onRelease);
    reducedMotion.addEventListener("change", onReducedMotion);
    signal?.addEventListener("abort", dispose, { once: true });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    discover();
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
