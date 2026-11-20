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

/**
 * Bumped by each request to show a place, so the views reveal it again even
 * when it has not changed. The page's route has no such requests: 0.
 */
export const RevealRequestContext = createContext(0);

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

const windowWidth = () => (typeof window === "undefined" ? 1280 : window.innerWidth);

/**
 * The element's width from ResizeObserver entries only, so mounting never
 * forces layout. Until the first entry it guesses the window's width; with
 * `measured`, it is null until then, for a container the window says nothing
 * about, such as a side panel tab.
 */
export function useWidth(ref: RefObject<HTMLElement | null>): number;
export function useWidth(ref: RefObject<HTMLElement | null>, measured: true): number | null;
export function useWidth(ref: RefObject<HTMLElement | null>, measured = false): number | null {
  // Without ResizeObserver there is no measure to wait for: take the window's width.
  const [width, setWidth] = useState<number | null>(() =>
    measured && typeof ResizeObserver !== "undefined" ? null : windowWidth(),
  );
  // The element may be replaced while the hook's component stays: check after every render.
  const watched = useRef<{ element: HTMLElement; observer: ResizeObserver } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (watched.current?.element === element) return;
    watched.current?.observer.disconnect();
    watched.current = null;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    watched.current = { element, observer };
  });
  useEffect(
    () => () => {
      watched.current?.observer.disconnect();
      watched.current = null;
    },
    [],
  );
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
