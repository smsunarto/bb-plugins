/**
 * Small hooks the review page shares: where it is (from the panel's
 * subPath), how to move, how wide its container is, and the current time.
 */
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ChangeKey } from "../../core/ids.ts";
import { reviewPath, type ReviewLocation } from "../../core/review.ts";

export const PANEL_PATH = "source-control";

export type Go = (
  location: Partial<ReviewLocation> & { key: ChangeKey },
  options?: { replace?: boolean },
) => void;

/**
 * How the review moves when it is not the page: the side panel's Review tab
 * keeps its place itself, and has no Changes list to go back to.
 */
export type ReviewHost = { go: Go };
export const ReviewHostContext = createContext<ReviewHost | null>(null);

/** Whether the review is the page, with its route and Changes list. */
export function useIsPage(): boolean {
  return useContext(ReviewHostContext) === null;
}

/** Moves within the review; one stable function for every row and tab. */
export function useGo(): Go {
  const host = useContext(ReviewHostContext);
  const page = usePageGo();
  return host?.go ?? page;
}

function usePageGo(): Go {
  const navigate = useBbNavigate();
  const latest = useRef(navigate);
  useLayoutEffect(() => {
    latest.current = navigate;
  });
  return useMemo<Go>(
    () => (location, options) =>
      latest.current.toPluginPanel(PANEL_PATH, {
        subPath: reviewPath(location),
        replace: options?.replace,
      }),
    [],
  );
}

/**
 * The element's width from ResizeObserver entries only, so mounting never
 * forces layout. Until the first entry it takes `guess`, else the window's width.
 */
export function useWidth(ref: RefObject<HTMLElement | null>, guess?: number): number {
  const [width, setWidth] = useState(
    () => guess ?? (typeof window === "undefined" ? 1280 : window.innerWidth),
  );
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Wide enough for the rail beside the diffs. */
export const WIDE = 1024;
/** Narrower than this, the page is the phone list. */
export const PHONE = 640;

/** The current time, ticking so ages stay true. */
export function useNow(every = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}
