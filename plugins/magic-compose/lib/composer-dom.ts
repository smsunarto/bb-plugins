// The plugin SDK has no way to hold a composer's send, so while Magic Compose is still
// deciding where a draft should run, it is held here against the composer's
// DOM. Every selector BB's markup is trusted for lives in this file. A BB
// release that renames them stops the hold, so a draft could be sent a moment
// before Magic Compose has caught up with it; nothing worse.

const COMPOSER_ROOT = "[data-app-composer]";
const EDITOR = "[data-promptbox-editor-content]";
const TYPEAHEAD_MENU = "[data-promptbox-typeahead-menu]";
const SUBMIT_BUTTON = 'button[type="submit"][data-promptbox-submit-action]';

/** Set to "pending" on the composer root while send is held; app.css dims the button under it. */
export const HOLD_ATTRIBUTE = "data-magic-compose";

/** The composer containing `element`, the plugin's own button for one. */
export function findComposer(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>(COMPOSER_ROOT);
}

function within(target: EventTarget | null, selector: string): boolean {
  return target instanceof Element && target.closest(selector) !== null;
}

/**
 * Swallow every way of sending the draft for as long as `isHeld()` says so.
 * Listeners sit on the composer root in the capture phase, ahead of the
 * editor's keymap and React's form handler. Returns a disposer.
 */
export function holdSubmit(root: HTMLElement, isHeld: () => boolean): () => void {
  const hold = (event: Event) => {
    if (!isHeld()) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (!within(event.target, EDITOR)) return;
    // Enter picks the highlighted @-mention or slash command.
    if (document.querySelector(TYPEAHEAD_MENU) !== null) return;
    // On touch keyboards Enter is a newline; sending is the button's job.
    if (window.matchMedia("(pointer: coarse)").matches) return;
    hold(event);
  };

  // BB sends on touch from pointerup, before any click or form submit.
  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerType === "touch" && within(event.target, SUBMIT_BUTTON)) hold(event);
  };

  const onClick = (event: MouseEvent) => {
    if (within(event.target, SUBMIT_BUTTON)) hold(event);
  };

  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("submit", hold, true);
  root.addEventListener("pointerup", onPointerUp, true);
  root.addEventListener("click", onClick, true);
  return () => {
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("submit", hold, true);
    root.removeEventListener("pointerup", onPointerUp, true);
    root.removeEventListener("click", onClick, true);
  };
}
