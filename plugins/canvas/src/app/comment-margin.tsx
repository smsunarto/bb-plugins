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
  snapshot: HTMLElement;
}

function animateToggle(rail: HTMLElement, items: MarginItem[], previous: PointerOrigin) {
  const item = items.find((candidate) => candidate.id === previous.id);
  if (!item || item.minimized === previous.minimized) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const element = Array.from(rail.children).find(
    (child) => (child as HTMLElement).dataset.marginId === previous.id,
  );
  const surface = element?.querySelector<HTMLElement>(".canvas-comment-motion");
  if (!surface) return;
  const next = surface.getBoundingClientRect();
  const x = previous.rect.left - next.left;
  const y = previous.rect.top - next.top;
  const target = item.minimized ? previous.snapshot : surface;
  const width = item.minimized ? previous.width : next.width;
  const height = item.minimized ? previous.height : next.height;
  if (!width || !height) return;
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
  // Animate the visual bounds, leaving anchor measurement and scrolling untouched.
  const animation = target.animate(
    [
      { transform: transform(x, y, previous.rect.width, previous.rect.height) },
      { transform: transform(0, 0, next.width, next.height) },
    ],
    {
      duration: 200,
      fill: item.minimized ? "forwards" : "none",
      easing: getComputedStyle(rail).getPropertyValue("--canvas-comment-motion-ease").trim(),
    },
  );
  if (item.minimized) {
    const remove = () => target.remove();
    void animation.finished.then(remove, remove);
  }
  return animation;
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
  const pointerOrigin = useRef<PointerOrigin | null>(null);
  const motion = useRef<Animation | null>(null);
  useLayoutEffect(() => () => motion.current?.cancel(), []);
  useLayoutEffect(() => {
    const rail = margin.current;
    const editor = documentRef.current?.querySelector<HTMLElement>(".docs-prose");
    if (!rail || !editor || !visible) return;
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
        const element = Array.from(rail.children).find(
          (child) => (child as HTMLElement).dataset.marginId === item.id,
        ) as HTMLElement | undefined;
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
    if (pointerOrigin.current)
      motion.current = animateToggle(rail, items, pointerOrigin.current) ?? null;
    pointerOrigin.current = null;
    const resize = new ResizeObserver(schedule);
    resize.observe(editor);
    resize.observe(rail);
    for (const child of rail.children) resize.observe(child);
    const mutation = new MutationObserver(schedule);
    mutation.observe(editor, { subtree: true, childList: true, characterData: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
    };
  }, [items, documentRef, visible]);
  return (
    <div
      className="canvas-comment-margin"
      ref={margin}
      onKeyDownCapture={() => {
        pointerOrigin.current = null;
        motion.current?.cancel();
      }}
      onClickCapture={(event) => {
        pointerOrigin.current = null;
        if (!event.detail || !(event.target instanceof Element)) return;
        const trigger = event.target.closest(".canvas-comment-marker, .canvas-comment-float-close");
        const item = trigger?.closest<HTMLElement>(".canvas-comment-margin-item");
        const surface = item?.querySelector<HTMLElement>(".canvas-comment-motion");
        if (!item?.dataset.marginId || !surface) return;
        const animated = (motion.current?.effect as KeyframeEffect | null)?.target;
        const visibleSurface =
          motion.current?.playState === "running" &&
          animated instanceof HTMLElement &&
          animated.parentElement === item
            ? animated
            : surface;
        const rect = visibleSurface.getBoundingClientRect();
        const snapshot = visibleSurface.cloneNode(true) as HTMLElement;
        const width = visibleSurface.offsetWidth;
        const height = visibleSurface.offsetHeight;
        motion.current?.cancel();
        pointerOrigin.current = {
          id: item.dataset.marginId,
          minimized: item.dataset.minimized === "true",
          rect,
          width,
          height,
          snapshot,
        };
      }}
    >
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
