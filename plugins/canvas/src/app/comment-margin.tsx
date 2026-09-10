import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { Anchor } from "../shared/comments.ts";
import { quoteOffset, textIndex } from "./text-selection.ts";

function visibleBounds(element: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = innerHeight;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(ancestor).overflowY)) continue;
    const rect = ancestor.getBoundingClientRect();
    top = Math.max(top, rect.top);
    bottom = Math.min(bottom, rect.bottom);
  }
  return { top, bottom };
}

interface MarginItem {
  id: string;
  anchor: Anchor;
  minimized: boolean;
  content: ReactNode;
}

interface PointerOrigin {
  id: string;
  minimized: boolean;
  rect: DOMRect;
  width: number;
  height: number;
  snapshot: HTMLElement | null;
}

/** Where every conversation was when the pointer was released, so a toggle can start there. */
interface PointerOrigins {
  at: number;
  byId: Map<string, PointerOrigin>;
}

const ORIGIN_TTL_MS = 500;
const MOTION_MS = 200;

/** Everything inside the moving surface except the card's own background, border and shadow. */
const CONTENT_SELECTOR =
  ":scope > .canvas-comment-float-close, .canvas-comment-card > *, :scope > .canvas-comment-composer > *";

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function motionEase(rail: HTMLElement): string {
  return getComputedStyle(rail).getPropertyValue("--canvas-comment-motion-ease").trim();
}

function marginItem(rail: HTMLElement, id: string): HTMLElement | undefined {
  return Array.from(rail.children).find(
    (child) => (child as HTMLElement).dataset.marginId === id,
  ) as HTMLElement | undefined;
}

function animateToggle(rail: HTMLElement, items: MarginItem[], previous: PointerOrigin) {
  const item = items.find((candidate) => candidate.id === previous.id);
  if (!item || item.minimized === previous.minimized) return;
  if (reducedMotion()) return;
  const element = marginItem(rail, previous.id);
  const surface = element?.querySelector<HTMLElement>(".canvas-comment-motion");
  if (!surface) return;
  const next = surface.getBoundingClientRect();
  const x = previous.rect.left - next.left;
  const y = previous.rect.top - next.top;
  const target = item.minimized ? previous.snapshot : surface;
  const width = item.minimized ? previous.width : next.width;
  const height = item.minimized ? previous.height : next.height;
  if (!target || !width || !height) return;
  target.style.transformOrigin = "0 0";
  if (item.minimized) {
    // Keep the outgoing card visible while it contracts into the restored avatar.
    // It is a visual snapshot only, never another interactive conversation.
    target.inert = true;
    target.setAttribute("aria-hidden", "true");
    Object.assign(target.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: `${width}px`,
      height: `${height}px`,
      pointerEvents: "none",
    });
    element?.append(target);
  }
  const transform = (left: number, top: number, w: number, h: number) =>
    `translate(${left}px, ${top}px) scale(${w / width}, ${h / height})`;
  const easing = motionEase(rail);
  const fill = item.minimized ? "forwards" : "none";
  // Animate the visual bounds, leaving anchor measurement and scrolling untouched.
  const animation = target.animate(
    [
      { transform: transform(x, y, previous.rect.width, previous.rect.height) },
      { transform: transform(0, 0, next.width, next.height) },
    ],
    { duration: MOTION_MS, fill, easing },
  );
  const companions: Animation[] = [];
  // The avatar is a circle and the card is a rounded rectangle. A full ellipse on the
  // unscaled card scales down to the avatar's circle, so the corners morph instead of popping.
  const card = target.querySelector<HTMLElement>(".canvas-comment-card, .canvas-comment-composer");
  if (card) {
    const circle = `${card.offsetWidth / 2}px / ${card.offsetHeight / 2}px`;
    companions.push(
      card.animate(
        item.minimized
          ? [
              { borderRadius: "8px" },
              { borderRadius: "8px", offset: 0.6 },
              { borderRadius: circle },
            ]
          : [
              { borderRadius: circle, easing },
              { borderRadius: "8px", offset: 0.3 },
              { borderRadius: "8px" },
            ],
        { duration: MOTION_MS, fill, easing: "linear" },
      ),
    );
  }
  // Text squashed into a 28px box is noise. Hide the contents while the surface is
  // too small to read and let them fade in once the card is most of its final size.
  for (const content of target.querySelectorAll<HTMLElement>(CONTENT_SELECTOR)) {
    companions.push(
      content.animate(
        item.minimized
          ? [{ opacity: 1, easing }, { opacity: 0, offset: 0.4 }, { opacity: 0 }]
          : [{ opacity: 0 }, { opacity: 0, offset: 0.25, easing }, { opacity: 1 }],
        { duration: MOTION_MS, fill, easing: "linear" },
      ),
    );
  }
  const settle = () => {
    for (const companion of companions) companion.cancel();
    if (item.minimized) target.remove();
  };
  void animation.finished.then(settle, settle);
  return animation;
}

/** A conversation that kept its state but was pushed aside slides instead of jumping. */
function animateShift(rail: HTMLElement, previous: PointerOrigin) {
  if (reducedMotion()) return;
  const surface = marginItem(rail, previous.id)?.querySelector<HTMLElement>(
    ".canvas-comment-motion",
  );
  if (!surface) return;
  const next = surface.getBoundingClientRect();
  const dx = previous.rect.left - next.left;
  const dy = previous.rect.top - next.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  return surface.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }],
    { duration: MOTION_MS, fill: "none", easing: motionEase(rail) },
  );
}

function captureOrigins(rail: HTMLElement, motions: Map<string, Animation>): PointerOrigins {
  const byId = new Map<string, PointerOrigin>();
  for (const child of rail.children) {
    const item = child as HTMLElement;
    const id = item.dataset.marginId;
    const surface = item.querySelector<HTMLElement>(".canvas-comment-motion");
    if (!id || !surface) continue;
    const running = motions.get(id);
    const animated = (running?.effect as KeyframeEffect | null)?.target;
    // A card mid-flight is measured where it visually is, not where React laid it out.
    const visible =
      running?.playState === "running" &&
      animated instanceof HTMLElement &&
      animated.parentElement === item
        ? animated
        : surface;
    const minimized = item.dataset.minimized === "true";
    let snapshot: HTMLElement | null = null;
    if (!minimized) {
      snapshot = visible.cloneNode(true) as HTMLElement;
      // cloneNode copies a textarea's initial text, not what the user has typed since.
      const fields = visible.querySelectorAll("textarea");
      snapshot.querySelectorAll("textarea").forEach((field, index) => {
        field.value = fields[index]?.value ?? "";
      });
    }
    byId.set(id, {
      id,
      minimized,
      rect: visible.getBoundingClientRect(),
      width: visible.offsetWidth,
      height: visible.offsetHeight,
      snapshot,
    });
  }
  return { at: performance.now(), byId };
}

/**
 * After React committed a pointer-initiated change, start every conversation from where it was.
 * Returns whether a toggle consumed the origins; unrelated renders (polls) must not eat them
 * before the click that follows the pointer release arrives.
 */
function replayOrigins(
  rail: HTMLElement,
  items: MarginItem[],
  origins: PointerOrigins | null,
  motions: Map<string, Animation>,
): boolean {
  if (!origins || performance.now() - origins.at >= ORIGIN_TTL_MS) return true;
  let toggled = false;
  for (const origin of origins.byId.values()) {
    const item = items.find((candidate) => candidate.id === origin.id);
    if (!item) continue;
    let animation: Animation | undefined;
    if (item.minimized !== origin.minimized) {
      toggled = true;
      motions.get(origin.id)?.cancel();
      animation = animateToggle(rail, items, origin);
    } else if (motions.get(origin.id)?.playState !== "running") {
      animation = animateShift(rail, origin);
    }
    if (animation) motions.set(origin.id, animation);
  }
  return toggled;
}

/** Comments share the document's scroll surface and follow their exact text anchors. */
export function CommentMargin({
  items,
  documentRef,
  visible,
  onDismiss,
}: {
  items: MarginItem[];
  documentRef: RefObject<HTMLDivElement | null>;
  visible: boolean;
  onDismiss(id: string): void;
}) {
  const margin = useRef<HTMLDivElement>(null);
  const pointerOrigins = useRef<PointerOrigins | null>(null);
  const motions = useRef(new Map<string, Animation>());
  const cancelMotions = () => {
    for (const animation of motions.current.values()) animation.cancel();
    motions.current.clear();
  };
  useLayoutEffect(() => cancelMotions, []);
  useLayoutEffect(() => {
    const rail = margin.current;
    const editor = documentRef.current?.querySelector<HTMLElement>(".docs-prose");
    if (!rail || !editor || !visible) {
      pointerOrigins.current = null;
      cancelMotions();
      return;
    }
    let frame = 0;
    const layout = () => {
      const index = textIndex(editor);
      const bounds = rail.getBoundingClientRect();
      const origin = bounds.top;
      const editorBounds = editor.getBoundingClientRect();
      const overlay =
        getComputedStyle(rail).getPropertyValue("--canvas-comment-overlay").trim() === "1";
      const { top: viewportTop, bottom: viewportBottom } = visibleBounds(editor);
      const cards = items.map((item) => {
        const element = marginItem(rail, item.id);
        const offset = quoteOffset(index.text, item.anchor);
        const range =
          offset !== null && item.anchor.quote
            ? index.range(offset, item.anchor.quote.length)
            : null;
        const rect = range?.getBoundingClientRect?.();
        const size = element?.getBoundingClientRect();
        let top = rect ? Math.max(0, rect.top - origin) : null;
        let left = 0;
        if ((overlay || item.minimized) && rect && size) {
          top = rect.top - origin - size.height - 10;
          // Flip below a visible passage when there is no room above it.
          if (rect.top >= viewportTop && rect.top - size.height - 10 < viewportTop) {
            top = Math.min(rect.bottom + 10, viewportBottom - size.height - 8) - origin;
          }
          const leftEdge = overlay ? bounds.left + 8 : editorBounds.left;
          const rightEdge = overlay ? bounds.right - 8 : editorBounds.right;
          left = Math.max(leftEdge, Math.min(rect.left, rightEdge - size.width)) - bounds.left;
        }
        return { element, top, left, width: size?.width ?? 0, minimized: item.minimized };
      });
      // Detached anchors follow located threads instead of pretending to match text.
      cards.sort((a, b) => (a.top ?? Infinity) - (b.top ?? Infinity));
      let bottom = 0;
      const occupied: { left: number; right: number; top: number; bottom: number }[] = [];
      for (const { element, top, left, width, minimized } of cards) {
        if (!element) continue;
        let y = top ?? bottom;
        let x = left;
        const height = element.getBoundingClientRect().height;
        for (const previous of occupied) {
          if (
            x >= previous.right + 4 ||
            x + width + 4 <= previous.left ||
            y >= previous.bottom + 4 ||
            y + height + 4 <= previous.top
          )
            continue;
          if (minimized && bounds.left + previous.right + width + 4 <= editorBounds.right)
            x = previous.right + 4;
          else y = previous.bottom + 10;
        }
        element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        occupied.push({ left: x, right: x + width, top: y, bottom: y + height });
        bottom = Math.max(bottom, y + height + 10);
      }
      rail.style.minHeight = overlay ? "0px" : `${Math.max(0, bottom)}px`;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(layout);
    };
    layout();
    if (replayOrigins(rail, items, pointerOrigins.current, motions.current))
      pointerOrigins.current = null;
    // Pointer releases may become a toggle a moment later (a click, or the document's pointerup).
    // Remember where everything is now; keyboard actions stay instant, so a key press forgets it.
    const remember = () => {
      pointerOrigins.current = captureOrigins(rail, motions.current);
    };
    const forget = () => {
      pointerOrigins.current = null;
      cancelMotions();
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(editor);
    resize.observe(rail);
    for (const child of rail.children) resize.observe(child);
    const mutation = new MutationObserver(schedule);
    mutation.observe(editor, { subtree: true, childList: true, characterData: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("pointerup", remember, true);
    document.addEventListener("keydown", forget, true);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("pointerup", remember, true);
      document.removeEventListener("keydown", forget, true);
    };
  }, [items, documentRef, visible]);
  return (
    <div className="canvas-comment-margin" ref={margin}>
      {items.map((item) => (
        <div
          className="canvas-comment-margin-item"
          data-margin-id={item.id}
          data-minimized={item.minimized}
          key={item.id}
        >
          <div className="canvas-comment-motion">
            <button
              type="button"
              className="canvas-comment-float-close canvas-review-icon-button"
              aria-label={item.id === "draft" ? "Close comment draft" : "Minimize comment"}
              title={item.id === "draft" ? "Close comment draft" : "Minimize comment"}
              onClick={() => onDismiss(item.id)}
            >
              ×
            </button>
            {item.content}
          </div>
        </div>
      ))}
    </div>
  );
}
