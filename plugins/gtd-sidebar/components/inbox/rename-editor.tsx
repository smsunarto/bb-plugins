// Ported from get-bb/bb `plugins/thread-list/app/rows/SidebarRenameEditor.tsx`
// at desktop-v0.44.0 (MIT), without the clear button bb draws for names that
// can fall back to a default. A thread title cannot.
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { cn } from "../../lib/utils";
import type { RenameStore } from "./inline-rename";

function readHttpError(error: unknown): { status: number | null } | null {
  if (typeof error !== "object" || error === null) return null;
  const status = "status" in error && typeof error.status === "number" ? error.status : null;
  return status === null ? null : { status };
}

export function renameError(error: unknown): { error: string; cannotRetry: boolean } {
  const http = readHttpError(error);
  if (http?.status === 404 || http?.status === 410) {
    return { error: "This thread no longer exists.", cannotRetry: true };
  }
  if (http?.status === 401 || http?.status === 403) {
    return { error: "You do not have permission to rename this thread.", cannotRetry: true };
  }
  return { error: "Could not save the name. Try again.", cannotRetry: false };
}

/**
 * The title's in-place editor. Enter saves, Escape cancels, and leaving the
 * editor saves. The row's own gestures (open, drag, context menu) stop at its
 * edge, so typing and selecting never reach the row underneath.
 *
 * Focus returns to the row's `[data-sidebar-rename-anchor]` after a keyboard
 * save or cancel, found through the enclosing `[data-sidebar-rename-row]`.
 */
export function RenameEditor({ store }: { store: RenameStore }) {
  const session = useSyncExternalStore(store.subscribe, store.get);
  const isPending = Boolean(session?.pending);
  const inputRef = useRef<HTMLInputElement>(null);
  const groupRef = useRef<HTMLSpanElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(false);
  const composingRef = useRef(false);
  const openingRef = useRef(true);
  const errorId = useId();

  useEffect(() => {
    const input = inputRef.current;
    const row = input?.closest("[data-sidebar-rename-row]");
    anchorRef.current = row?.querySelector<HTMLElement>("[data-sidebar-rename-anchor]") ?? null;
    const frame = requestAnimationFrame(() => {
      input?.focus({ preventScroll: true });
      // A fresh editor offers the whole name; one remounted mid-edit (the row
      // moved shelves) keeps the draft and puts the caret after it.
      const current = store.get();
      if (current === null || current.draft === current.name) input?.select();
      else input?.setSelectionRange(current.draft.length, current.draft.length);
      openingRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [store]);

  const restoreFocus = () => {
    const anchor = anchorRef.current;
    requestAnimationFrame(() => {
      if (
        anchor?.isConnected &&
        (document.activeElement === document.body ||
          groupRef.current?.contains(document.activeElement))
      ) {
        anchor.focus({ preventScroll: true });
      }
    });
  };

  const submit = async (restore: boolean) => {
    restoreFocusRef.current = restore;
    const input = inputRef.current;
    input?.setSelectionRange(input.value.length, input.value.length);
    const saved = await store.save();
    if (saved && restoreFocusRef.current) restoreFocus();
  };

  const cancel = (restore: boolean) => {
    if (isPending) return;
    store.cancel();
    if (restore) restoreFocus();
  };

  // The row drops the editor on the same update that clears the session.
  if (session === null) return null;

  return (
    // The span only fences the row's gestures off the input; it is not a control.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <span
      ref={groupRef}
      data-sidebar-rename-editor=""
      className="relative z-50 flex min-w-0 flex-1 items-center gap-1"
      aria-busy={isPending}
      onBlur={(event) => {
        if (openingRef.current || event.currentTarget.contains(event.relatedTarget)) return;
        // Chromium blurs a focused element as it leaves the DOM. When the row
        // remounts in another shelf the session carries on there, so a blur
        // that ends with the editor gone is no reason to save.
        const group = event.currentTarget;
        queueMicrotask(() => {
          if (!group.isConnected) return;
          restoreFocusRef.current = false;
          if (!isPending) void submit(false);
        });
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyUp={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || composingRef.current) return;
        if (event.key === "Escape") {
          event.preventDefault();
          cancel(true);
        } else if (event.key === "Enter" && event.target === inputRef.current) {
          event.preventDefault();
          void submit(true);
        }
      }}
    >
      <input
        ref={inputRef}
        aria-label="Thread name"
        aria-invalid={Boolean(session.error)}
        aria-describedby={session.error ? errorId : undefined}
        autoCapitalize="sentences"
        autoCorrect="off"
        className={cn(
          "min-w-0 flex-1 appearance-none border-0 bg-transparent px-0 py-0 [font:inherit] outline-none",
          isPending && "opacity-60",
        )}
        spellCheck={false}
        value={session.draft}
        readOnly={isPending || session.cannotRetry}
        onChange={(event) => store.change(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
      />
      {isPending && <output className="sr-only">Saving name</output>}
      {session.error && (
        <span
          id={errorId}
          role="alert"
          className="absolute left-0 top-full z-50 mt-1 w-full min-w-40 whitespace-normal rounded-md border border-border bg-popover px-2 py-1 text-xs text-destructive-text shadow-md"
        >
          {session.error}
        </span>
      )}
    </span>
  );
}
