type Preview = ReturnType<typeof createPreviewExpansion>;

const documents = new WeakMap<Document, Map<string, Set<Preview>>>();
const pending = new Set<Set<Preview>>();

function reconcile(previews: Set<Preview>) {
  if (pending.has(previews)) return;
  pending.add(previews);
  // Register the whole React commit before opening anything. Older previews
  // must not briefly mount and fetch while later siblings are registering.
  queueMicrotask(() => {
    pending.delete(previews);
    const ordered = [...previews].sort((a, b) => {
      const position = a.element!.compareDocumentPosition(b.element!);
      return position & 4 ? -1 : position & 2 ? 1 : 0;
    });
    const latest = new Set(ordered.slice(-2));
    for (const preview of ordered) preview.setDefault(latest.has(preview));
  });
}

/**
 * Upstream inline-vis remembers the last collapse or expand choice on this
 * client. Here that choice decides whether the latest two previews open by
 * themselves. It is read once per occurrence, so it never closes an open card.
 */
function readCollapsedPreference(storageKey: string): boolean {
  try {
    return window.localStorage.getItem(storageKey) === "true";
  } catch {
    return false;
  }
}

function writeCollapsedPreference(storageKey: string, collapsed: boolean): void {
  try {
    window.localStorage.setItem(storageKey, String(collapsed));
  } catch {
    // Storage can be unavailable; the choice still applies to this card.
  }
}

/** One mounted directive occurrence, not one file or message. */
export function createPreviewExpansion(storageKey: string) {
  const collapsedByDefault = readCollapsedPreference(storageKey);
  let automatic = false;
  let override: boolean | undefined;
  const listeners = new Set<() => void>();
  const preview = {
    element: null as HTMLElement | null,
    getSnapshot: () => override ?? (automatic && !collapsedByDefault),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDefault(expanded: boolean) {
      const previous = preview.getSnapshot();
      automatic = expanded;
      if (previous !== preview.getSnapshot()) for (const listener of listeners) listener();
    },
    toggle() {
      override = !preview.getSnapshot();
      writeCollapsedPreference(storageKey, !override);
      for (const listener of listeners) listener();
    },
    register(threadId: string, element: HTMLElement) {
      preview.element = element;
      const threads = documents.get(element.ownerDocument) ?? new Map<string, Set<Preview>>();
      documents.set(element.ownerDocument, threads);
      const previews = threads.get(threadId) ?? new Set<Preview>();
      threads.set(threadId, previews);
      previews.add(preview);
      reconcile(previews);
      return () => {
        previews.delete(preview);
        if (previews.size === 0) threads.delete(threadId);
        reconcile(previews);
        preview.element = null;
      };
    },
  };
  return preview;
}
