import { useEffect, type RefObject } from "react";

// BB's inset and Monokai's web frame are outside the navPanel slot.
// Bounded split panes have data-focused. Leave their shared frame intact.
const LAYOUT_ROOT_SELECTOR = '[data-testid="app-layout-root"]';
const FOCUSED_SPLIT_SELECTOR = "[data-split-pane-id][data-focused]";
export const TASKS_PAGE_UNFRAMED_ATTR = "data-scott-tasks-unframed";
export const TASKS_PAGE_FRAME_STYLE_ATTR = "data-scott-tasks-frame-style";

const FRAME_STYLE_CSS = `
  @media (min-width: 768px) {
    ${LAYOUT_ROOT_SELECTOR}[${TASKS_PAGE_UNFRAMED_ATTR}]:not([data-framed]) {
      padding: 0;
    }
    ${LAYOUT_ROOT_SELECTOR}[${TASKS_PAGE_UNFRAMED_ATTR}] > [data-sidebar="inset"] {
      --bb-frame-card-radius: 0px;
      border-radius: 0;
      mask-image: none;
      clip-path: none;
    }
    ${LAYOUT_ROOT_SELECTOR}[${TASKS_PAGE_UNFRAMED_ATTR}] > [data-sidebar="inset"] > [data-app-content-shell]::after {
      display: none;
    }
    ${LAYOUT_ROOT_SELECTOR}[${TASKS_PAGE_UNFRAMED_ATTR}] > [data-sidebar="inset"] > [data-sidebar="inset-edge"] {
      display: none;
    }
  }
`;

let activeFrameMounts = 0;
let styleElement: HTMLStyleElement | null = null;

function retainFrameStyle(): void {
  activeFrameMounts += 1;
  if (styleElement !== null && styleElement.isConnected) return;
  const style = document.createElement("style");
  style.setAttribute(TASKS_PAGE_FRAME_STYLE_ATTR, "");
  style.textContent = FRAME_STYLE_CSS;
  document.head.append(style);
  styleElement = style;
}

function releaseFrameStyle(): void {
  activeFrameMounts = Math.max(0, activeFrameMounts - 1);
  if (activeFrameMounts > 0) return;
  styleElement?.remove();
  styleElement = null;
}

/**
 * Unframe BB's outer inset only while the Tasks navPanel is mounted and not
 * inside a focused split pane. Keeps scott-tasks's stylesheet and frame CSS
 * completely off every other BB screen and avoids page-level `:has()`.
 */
export function useTasksPageFrame(pageRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    retainFrameStyle();

    const root =
      pageRef.current?.closest<HTMLElement>(LAYOUT_ROOT_SELECTOR) ??
      document.querySelector<HTMLElement>(LAYOUT_ROOT_SELECTOR);

    if (root === null) {
      return () => {
        releaseFrameStyle();
      };
    }

    const sync = () => {
      if (root.querySelector(FOCUSED_SPLIT_SELECTOR) !== null) {
        root.removeAttribute(TASKS_PAGE_UNFRAMED_ATTR);
      } else {
        root.setAttribute(TASKS_PAGE_UNFRAMED_ATTR, "");
      }
    };

    sync();

    const observer = new MutationObserver(sync);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-focused", "data-split-pane-id"],
    });

    return () => {
      observer.disconnect();
      root.removeAttribute(TASKS_PAGE_UNFRAMED_ATTR);
      releaseFrameStyle();
    };
  }, [pageRef]);
}
