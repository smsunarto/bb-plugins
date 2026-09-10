import { useMemo } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { Anchor } from "../shared/comments.ts";
import { CommentIcon } from "./comments.tsx";

export interface ReviewSelection {
  anchor: Anchor;
  range: Range;
  editor: HTMLElement;
  backward: boolean;
}

/** Use the visible end of the selection, including long, multi-block selections. */
export function selectionRect(selection: ReviewSelection): DOMRect {
  const rects = Array.from(selection.range.getClientRects?.() ?? []).filter(
    (rect) => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight,
  );
  return (selection.backward ? rects[0] : rects.at(-1)) ?? selection.range.getBoundingClientRect();
}

export function SelectionActions({
  selection,
  onComment,
  onDismiss,
  resume = false,
}: {
  selection: ReviewSelection;
  onComment(anchor: Anchor): void;
  onDismiss(): void;
  resume?: boolean;
}) {
  const virtualRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => selectionRect(selection),
        contextElement: selection.editor,
      },
    }),
    [selection],
  );
  return (
    <Popover.Root open modal={false}>
      <Popover.Anchor virtualRef={virtualRef} />
      <Popover.Portal>
        <Popover.Content
          className="canvas-review-selection"
          aria-label="Selection actions"
          side="top"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={onDismiss}
        >
          <button
            type="button"
            className="canvas-review-selection-action"
            aria-label={resume ? "Continue comment" : "Comment"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onComment(selection.anchor)}
          >
            <CommentIcon />
            {resume ? "Continue comment" : "Comment"}
            <kbd aria-hidden="true">⌘⇧M</kbd>
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
