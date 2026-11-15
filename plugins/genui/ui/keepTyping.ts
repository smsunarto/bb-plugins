// A control that picks or sets something and lets the user go on typing (a
// reply Button, a Choice, a Form toggle) must not take focus from the text
// field the user is typing in, the composer or a Form field: on a phone that
// drops the soft keyboard. Spread `keepTyping` on such a control; it still
// acts on click.
import type { MouseEvent, PointerEvent } from "react";

const TEXTLESS_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Whether `element` takes typing, so its focus holds a phone's keyboard up. */
function takesTyping(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  if (element instanceof HTMLInputElement)
    return !element.readOnly && !element.disabled && !TEXTLESS_INPUTS.has(element.type);
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * Press handlers that keep focus where the user is typing: while a text
 * field has focus, a press doesn't move it. A touch or pen press is
 * cancelled at pointerdown, a mouse press at mousedown (cancelling a mouse's
 * pointerdown would also suppress mousedown handlers further up). With no
 * text field focused, presses behave as usual.
 */
export const keepTyping = {
  onPointerDown(event: PointerEvent<HTMLElement>): void {
    if (event.pointerType !== "mouse" && takesTyping(document.activeElement))
      event.preventDefault();
  },
  onMouseDown(event: MouseEvent<HTMLElement>): void {
    if (takesTyping(document.activeElement)) event.preventDefault();
  },
};
