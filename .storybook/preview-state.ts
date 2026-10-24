import type { PreviewLocation } from "./editor-frame";

const storageKey = (url: URL) =>
  `bb.storybook.reload:${url.pathname}:${url.searchParams.get("id")}`;
type ReloadState = Pick<PreviewLocation, "storyId" | "args" | "globals">;

export function persistPreviewState(location: PreviewLocation, target: string) {
  const args: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(location.args)) {
    if (value === location.initialArgs[name]) continue;
    try {
      // Runtime handlers and rich fixture objects belong to the story, not storage.
      const encoded = JSON.stringify(value, (_key, item) => {
        if (
          typeof item === "function" ||
          typeof item === "symbol" ||
          (item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            Object.getPrototypeOf(item) !== Object.prototype)
        )
          throw new Error("Non-JSON story fixture");
        return item;
      });
      if (encoded !== undefined) args[name] = JSON.parse(encoded);
    } catch {
      /* Non-serializable values are recreated by the story. */
    }
  }
  sessionStorage.setItem(
    storageKey(new URL(target)),
    JSON.stringify({
      storyId: location.storyId,
      args,
      globals: location.globals,
    } satisfies ReloadState),
  );
}

export function readPreviewState(): ReloadState | undefined {
  if (typeof window === "undefined") return;
  const key = storageKey(new URL(window.location.href));
  const raw = sessionStorage.getItem(key);
  if (!raw) return;
  sessionStorage.removeItem(key);
  try {
    const state = JSON.parse(raw);
    if (typeof state.storyId === "string" && state.args && state.globals) return state;
  } catch {
    /* Ignore an interrupted or obsolete reload snapshot. */
  }
}
