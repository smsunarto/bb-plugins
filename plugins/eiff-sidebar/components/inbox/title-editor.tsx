import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * The title turned into a text field, in place.
 *
 * Presentational on purpose: it owns focus, the keys, and nothing else. The
 * card owns the rename call and what to do when it fails, because the card is
 * what knows the thread.
 *
 * Uncontrolled, so a thread update arriving mid-edit cannot overwrite what is
 * being typed. bb pushes new thread data on every lifecycle event, and a card
 * being renamed is usually a card that just changed state.
 *
 * Escape cancels and Enter commits. Blur commits too, because a click landing
 * elsewhere in the sidebar reads as "done", not as "throw that away" — and a
 * cancel already left through Escape by then, which is why `settled` exists:
 * Escape blurs the input on its way out, and without the guard that blur would
 * commit the edit Escape just discarded.
 */
export function TitleEditor({
  initialTitle,
  className,
  onCommit,
  onCancel,
}: {
  initialTitle: string;
  className?: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  // Select rather than place a caret: a thread title is usually replaced
  // wholesale, and the first keystroke should not have to clear it first.
  //
  // Twice, because the context menu opens this field while its own menu is
  // still mounted. The menu unmounts a frame later, and the focused element
  // going away drops focus to `body` — taking this field's focus with it, even
  // though the menu waives its focus restore. The second pass runs after that
  // unmount and is a no-op on the double-click path, which never lost it.
  useEffect(() => {
    const focus = () => {
      const input = inputRef.current;
      if (!input || settled.current || document.activeElement === input) return;
      input.focus();
      input.select();
    };
    focus();
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, []);

  const settle = (run: () => void) => {
    if (settled.current) return;
    settled.current = true;
    run();
  };

  return (
    <input
      ref={inputRef}
      type="text"
      aria-label="Thread title"
      defaultValue={initialTitle}
      // The row underneath is pointer-events-none, and this needs the clicks.
      className={cn(
        "pointer-events-auto min-w-0 flex-1 rounded-sm bg-transparent px-0 text-sm",
        "text-sidebar-accent-foreground outline-none",
        // A one-pixel rule under the text rather than a box: the row is 20px
        // tall and a bordered field at this size reflows everything beside it.
        "border-0 border-b border-sidebar-accent-foreground/40",
        className,
      )}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // The sidebar binds single-key thread shortcuts, so every key pressed
        // in here stops at the field.
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          settle(() => onCommit(event.currentTarget.value));
        } else if (event.key === "Escape") {
          event.preventDefault();
          settle(onCancel);
        }
      }}
      onBlur={(event) => settle(() => onCommit(event.currentTarget.value))}
    />
  );
}
