// The outgoing conversation, kept on screen after bb unmounts it.
//
// Switching threads detaches the whole timeline pane, and the replacement's
// row list mounts a few frames later. In between, the pane is blank. A ghost
// lifts the detached scroll area back into the document, pinned exactly where
// it was, inert and pointer-transparent, until the replacement is in place.
// Nothing in it answers bb's lookups: the attributes bb finds rows and footers
// by are stripped before it is shown again.

export interface TimerScheduler {
  set(callback: () => void, delayMs: number): number;
  clear(handle: number): void;
}

export const GHOST_CLASS = "smooth-thread-switch-ghost";
/** How long a ghost covers the pane while no replacement adopts it. */
export const GHOST_CAP_MS = 800;
/** No ghost outlives this, whatever else goes wrong around it. */
export const GHOST_MAX_MS = 1200;
/** Attributes bb finds rows and footers by. A ghost must never answer those lookups. */
const STRIPPED_ATTRIBUTES = [
  "id",
  "data-timeline-row-list",
  "data-timeline-row-id",
  "data-scroll-footer",
] as const;
const STRIPPED_SELECTOR = STRIPPED_ATTRIBUTES.map((name) => `[${name}]`).join(",");
const POSITIONED = new Set(["relative", "absolute", "fixed", "sticky"]);

/** Where a scroll area sits inside its containing block, and the ancestors it hangs from. */
export interface Placement {
  readonly container: HTMLElement;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Nearest first, ending with the container. */
  readonly lineage: readonly HTMLElement[];
}

export interface Ghost {
  readonly root: HTMLElement;
  /** The still-mounted ancestor the outgoing pane hung from. Its replacement mounts under it. */
  readonly anchor: HTMLElement;
}

interface GhostTimers {
  /** The unadopted cap. */
  phase: number | null;
  max: number | null;
}

/** The element absolute descendants of `element` are positioned against. */
export function findContainingBlock(element: HTMLElement): HTMLElement {
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    if (POSITIONED.has(window.getComputedStyle(ancestor).position)) return ancestor;
  }
  return document.body;
}

/** Measures a mounted scroll area. Null when it has no box to pin a ghost to. */
export function measurePlacement(area: HTMLElement): Placement | null {
  const rect = area.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const container = findContainingBlock(area);
  const containerRect = container.getBoundingClientRect();
  const lineage: HTMLElement[] = [];
  for (
    let ancestor = area.parentElement;
    ancestor !== null && ancestor !== container;
    ancestor = ancestor.parentElement
  ) {
    lineage.push(ancestor);
  }
  lineage.push(container);
  return {
    container,
    left: rect.left - containerRect.left - container.clientLeft + container.scrollLeft,
    top: rect.top - containerRect.top - container.clientTop + container.scrollTop,
    width: rect.width,
    height: rect.height,
    lineage,
  };
}

/**
 * The mounted ancestor a detached pane hung from, when a ghost placed against
 * the cached containing block would still land where the pane was.
 */
export function findAnchor(placement: Placement): HTMLElement | null {
  const anchor = placement.lineage.find((element) => element.isConnected);
  if (anchor === undefined || !placement.container.isConnected) return null;
  if (anchor !== placement.container && findContainingBlock(anchor) !== placement.container) {
    return null;
  }
  return anchor;
}

/** Makes a detached scroll area safe to show again: nothing bb queries, focuses, or reloads. */
function neutralize(area: HTMLElement): void {
  for (const element of [area, ...area.querySelectorAll<HTMLElement>(STRIPPED_SELECTOR)]) {
    for (const name of STRIPPED_ATTRIBUTES) element.removeAttribute(name);
  }
  for (const frame of area.querySelectorAll("iframe")) {
    // Re-inserting an iframe reloads its document. Show nothing there instead.
    frame.removeAttribute("srcdoc");
    frame.src = "about:blank";
  }
  area.style.width = "100%";
  area.style.height = "100%";
  area.style.margin = "0";
}

export class GhostRegistry {
  private readonly byAnchor = new Map<HTMLElement, Ghost>();
  private readonly timers = new Map<Ghost, GhostTimers>();
  private readonly scheduler: TimerScheduler;

  constructor(scheduler: TimerScheduler) {
    this.scheduler = scheduler;
  }

  /** The ghost already covering `anchor`, if any. */
  at(anchor: HTMLElement): Ghost | null {
    return this.byAnchor.get(anchor) ?? null;
  }

  /**
   * Pins a detached scroll area back over `anchor`, scrolled as it was. The
   * ghost expires on its own unless a hold adopts it first.
   */
  create(area: HTMLElement, placement: Placement, anchor: HTMLElement, scrollTop: number): Ghost {
    neutralize(area);
    const root = document.createElement("div");
    root.className = GHOST_CLASS;
    root.setAttribute("inert", "");
    root.setAttribute("aria-hidden", "true");
    root.style.left = `${placement.left}px`;
    root.style.top = `${placement.top}px`;
    root.style.width = `${placement.width}px`;
    root.style.height = `${placement.height}px`;
    root.append(area);
    anchor.append(root);
    area.scrollTop = scrollTop;
    const ghost: Ghost = { root, anchor };
    this.byAnchor.set(anchor, ghost);
    this.timers.set(ghost, {
      phase: null,
      max: this.scheduler.set(() => this.remove(ghost), GHOST_MAX_MS),
    });
    this.armCap(ghost);
    return ghost;
  }

  /** The ghost covering the pane `area` mounted into, with its expiry cancelled. */
  adopt(area: HTMLElement): Ghost | null {
    for (let element = area.parentElement; element !== null; element = element.parentElement) {
      const ghost = this.byAnchor.get(element);
      if (ghost !== undefined) {
        this.clearPhase(ghost);
        return ghost;
      }
    }
    return null;
  }

  /** A hold gave up on the ghost without revealing. It expires on its own again. */
  disown(ghost: Ghost): void {
    if (this.timers.has(ghost)) this.armCap(ghost);
  }

  /** Drops every ghost. Deleting the current key mid-iteration is safe. */
  removeAll(): void {
    for (const ghost of this.timers.keys()) this.remove(ghost);
  }

  private armCap(ghost: Ghost): void {
    this.clearPhase(ghost);
    const timers = this.timers.get(ghost);
    if (timers !== undefined) {
      timers.phase = this.scheduler.set(() => this.remove(ghost), GHOST_CAP_MS);
    }
  }

  private clearPhase(ghost: Ghost): void {
    const timers = this.timers.get(ghost);
    if (timers === undefined || timers.phase === null) return;
    this.scheduler.clear(timers.phase);
    timers.phase = null;
  }

  remove(ghost: Ghost): void {
    const timers = this.timers.get(ghost);
    if (timers === undefined) return;
    this.timers.delete(ghost);
    if (timers.phase !== null) this.scheduler.clear(timers.phase);
    if (timers.max !== null) this.scheduler.clear(timers.max);
    if (this.byAnchor.get(ghost.anchor) === ghost) this.byAnchor.delete(ghost.anchor);
    ghost.root.remove();
  }
}
