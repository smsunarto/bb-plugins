// Reading bb's own routes.
//
// Kept free of imports on purpose: the frontend bundle pulls these in, and
// anything they touched would be bundled with them.

/** `/threads/thr_abc` → `thr_abc`; anything else → null. */
export function threadIdFromRoute(route: string): string | null {
  return /\/threads?\/(thr_[A-Za-z0-9]+)/.exec(route)?.[1] ?? null;
}

/** `/projects/proj_abc/…` → `proj_abc`; anything else → null. */
export function projectIdFromRoute(route: string): string | null {
  return /\/projects?\/(proj_[A-Za-z0-9]+)/.exec(route)?.[1] ?? null;
}

/** `/plugins/github/issues` → `github`; anything else → null. */
export function panelPluginIdFromRoute(route: string): string | null {
  return /^\/plugins\/([^/]+)/.exec(route)?.[1] ?? null;
}

/** A short human label for a bb route, used in annotation listings. */
export function labelForRoute(route: string): string {
  const threadId = threadIdFromRoute(route);
  if (threadId) return `thread ${threadId}`;
  const pluginId = panelPluginIdFromRoute(route);
  if (pluginId) return `${pluginId} panel`;
  if (route === "/" || route === "") return "home";
  if (route.startsWith("/settings")) return "settings";
  return route;
}

const routeListeners = new Set<() => void>();
let teardownRouteEvents: (() => void) | null = null;

function notifyRouteListeners(): void {
  for (const listener of Array.from(routeListeners)) listener();
}

function installRouteEvents(): () => void {
  const cleanups: Array<() => void> = [];

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("popstate", notifyRouteListeners);
    window.addEventListener("hashchange", notifyRouteListeners);
    cleanups.push(() => {
      window.removeEventListener("popstate", notifyRouteListeners);
      window.removeEventListener("hashchange", notifyRouteListeners);
    });
  }

  const hist =
    typeof window !== "undefined" && window.history
      ? window.history
      : typeof history !== "undefined"
        ? history
        : null;
  if (hist) {
    const origPushState = hist.pushState;
    const origReplaceState = hist.replaceState;
    if (typeof origPushState === "function") {
      const wrappedPush: History["pushState"] = function (this: History, ...args) {
        const result = Reflect.apply(origPushState, this, args);
        notifyRouteListeners();
        return result;
      };
      hist.pushState = wrappedPush;
      cleanups.push(() => {
        if (hist.pushState === wrappedPush) hist.pushState = origPushState;
      });
    }
    if (typeof origReplaceState === "function") {
      const wrappedReplace: History["replaceState"] = function (this: History, ...args) {
        const result = Reflect.apply(origReplaceState, this, args);
        notifyRouteListeners();
        return result;
      };
      hist.replaceState = wrappedReplace;
      cleanups.push(() => {
        if (hist.replaceState === wrappedReplace) hist.replaceState = origReplaceState;
      });
    }
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * Subscribe to SPA route changes via navigation events (`popstate`,
 * `hashchange`, and reference-counted `history.pushState`/`replaceState`).
 * Restores patched history methods when the last subscriber unsubscribes.
 */
export function subscribeRouteChange(listener: () => void): () => void {
  if (routeListeners.size === 0) {
    teardownRouteEvents = installRouteEvents();
  }
  routeListeners.add(listener);
  return () => {
    routeListeners.delete(listener);
    if (routeListeners.size === 0) {
      teardownRouteEvents?.();
      teardownRouteEvents = null;
    }
  };
}
