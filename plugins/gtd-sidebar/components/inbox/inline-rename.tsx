// Ported from get-bb/bb `plugins/thread-list/app/rows/SidebarInlineRename.tsx`
// at desktop-v0.44.0 (MIT). Trimmed to threads: GTD renames nothing else in
// place, so the kinds, clear, and length limit bb uses for sections and
// machines are gone. The session lives in a store rather than React state, so
// a keystroke redraws the editor alone, not every memoized row in the list.
// The session is keyed by thread, not by the row that opened it: GTD moves a
// row between shelves while the list is live, and the remounted row picks
// the open editor and its draft back up instead of orphaning them.
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useIsCompactViewport } from "../ui/hooks/use-compact-viewport";
import { RenameEditor, renameError } from "./rename-editor";

export interface RenameSession {
  threadId: string;
  name: string;
  draft: string;
  pending: Promise<boolean> | null;
  error: string | null;
  cannotRetry: boolean;
}

type RenameThread = (threadId: string, title: string) => Promise<unknown>;

function createRenameStore(rename: { current: RenameThread }) {
  let session: RenameSession | null = null;
  let startRequest = 0;
  const listeners = new Set<() => void>();
  const update = (next: RenameSession | null) => {
    session = next;
    for (const listener of listeners) listener();
  };

  const save = (): Promise<boolean> => {
    const current = session;
    if (!current) return Promise.resolve(false);
    if (current.pending) return current.pending;
    if (current.cannotRetry) return Promise.resolve(false);
    const value = current.draft.trim();
    if (!value) {
      update({ ...current, error: "Name cannot be empty." });
      return Promise.resolve(false);
    }
    if (value === current.name.trim()) {
      update(null);
      return Promise.resolve(true);
    }
    const pending = Promise.resolve()
      .then(() => rename.current(current.threadId, value))
      .then(
        () => {
          update(null);
          return true;
        },
        (error: unknown) => {
          // The draft survives a failed save, so a retry sends the same name.
          update({ ...current, pending: null, ...renameError(error) });
          return false;
        },
      );
    update({ ...current, pending, error: null });
    return pending;
  };

  return {
    get: () => session,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    save,
    async start(args: Pick<RenameSession, "threadId" | "name">) {
      const request = ++startRequest;
      const current = session;
      if (current?.threadId === args.threadId) return;
      // One editor at a time: the open one saves before another row opens,
      // and an invalid draft keeps it open.
      if (current && !(await save())) return;
      if (request !== startRequest) return;
      update({ ...args, draft: args.name, pending: null, error: null, cannotRetry: false });
    },
    cancel() {
      if (session?.pending) return;
      ++startRequest;
      update(null);
    },
    change(draft: string) {
      if (session && !session.pending) {
        update({ ...session, draft, error: null, cannotRetry: false });
      }
    },
  };
}

export type RenameStore = ReturnType<typeof createRenameStore>;
const RenameContext = createContext<RenameStore | null>(null);

/**
 * One rename session for the whole list, saved through bb's silent `rename`.
 * The store is made once; the latest `rename` is read at save time.
 */
export function RenameProvider({
  renameThread,
  children,
}: {
  renameThread: RenameThread;
  children: ReactNode;
}) {
  const rename = useRef(renameThread);
  rename.current = renameThread;
  const [store] = useState(() => createRenameStore(rename));
  return <RenameContext.Provider value={store}>{children}</RenameContext.Provider>;
}

/**
 * Rename one thread in place. A row redraws only when its own editor opens or
 * closes.
 *
 * `startEditingFromMenu` waits for the menu to hand focus back
 * (`onCloseAutoFocus`) before it opens the editor, or the returning focus
 * would blur, and so save, the editor the moment it appears.
 */
export function useThreadRename(threadId: string, name: string) {
  const store = useContext(RenameContext);
  if (store === null) throw new Error("useThreadRename needs a RenameProvider");
  const compact = useIsCompactViewport();
  const pendingMenuRename = useRef<(() => void) | null>(null);
  const isEditing = useSyncExternalStore(store.subscribe, () => store.get()?.threadId === threadId);
  const startEditing = useCallback(() => {
    void store.start({ threadId, name });
  }, [name, store, threadId]);

  return {
    editor: isEditing ? <RenameEditor store={store} /> : null,
    isEditing,
    startEditing,
    /** For the row's link: a double-click renames, except on touch screens. */
    onDoubleClick:
      isEditing || compact
        ? undefined
        : (event: MouseEvent) => {
            event.preventDefault();
            startEditing();
          },
    startEditingFromMenu: () => {
      if (compact) startEditing();
      else pendingMenuRename.current = startEditing;
    },
    onCloseAutoFocus: (event: Event) => {
      const begin = pendingMenuRename.current;
      if (begin) {
        pendingMenuRename.current = null;
        event.preventDefault();
        begin();
      }
    },
  };
}

export type ThreadRename = ReturnType<typeof useThreadRename>;
