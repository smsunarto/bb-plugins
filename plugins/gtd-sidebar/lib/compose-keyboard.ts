/**
 * Opens the phone keyboard on the New thread composer once the drawer has
 * closed.
 *
 * bb's `toCompose({ focusPrompt: true })` skips focusing under a coarse
 * pointer, and iOS raises the keyboard only for a focus that starts inside
 * the tap itself (bb's iOS WebView keeps keyboardDisplayRequiresUserAction).
 * The composer mounts frames later, and the drawer takes about 350ms to slide
 * shut. So, during the tap, focus a hidden input with `inputmode="none"`,
 * which holds the tap's focus without raising a keyboard. Once the drawer
 * has fully closed and the composer's editor is on screen, move focus to the
 * editor; iOS shows the keyboard for a focus that moves from one focused
 * field to another. The keyboard so rises after the slide rather than racing
 * it. The proxy goes away as soon as the editor takes focus, or after
 * `TIMEOUT_MS` if it never does.
 *
 * Private bb DOM: the editor is bb's root compose prompt box,
 * `[data-promptbox]`, which bb's own composer and replacements such as
 * t3-composer both render. The drawer is the page bb slides aside,
 * `[data-sidebar="inset"]`: its `data-sidebar-shelf` stays "open" while it
 * slides shut under `data-vaul-animate`, then turns "closed" with the
 * attribute gone (lib/phone-drawer.ts). A navigation that keeps the compose
 * page mounted would leave a stale editor briefly in place, so the handoff
 * also waits `SETTLE_MS`.
 */
const EDITOR = '#root-compose-main-panel [data-promptbox] [contenteditable="true"]';
const PROXY_MARK = "data-gtd-keyboard-proxy";
const INSET = '[data-sidebar="inset"]';
const SETTLE_MS = 120;
const TIMEOUT_MS = 3000;
const RETRY_MS = 75;

/** Call synchronously from the tap's handler, before navigating. */
export function focusComposeEditorWithKeyboard(document: Document): void {
  const view = document.defaultView;
  if (view === null) return;
  document.querySelector(`[${PROXY_MARK}]`)?.remove();

  const proxy = document.createElement("input");
  proxy.setAttribute(PROXY_MARK, "");
  proxy.setAttribute("aria-hidden", "true");
  proxy.tabIndex = -1;
  proxy.inputMode = "none";
  // 16px keeps iOS from zooming into the field; fixed at the top keeps it
  // from scrolling anything into view.
  Object.assign(proxy.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    opacity: "0",
    fontSize: "16px",
    pointerEvents: "none",
  });
  document.body.append(proxy);
  proxy.focus({ preventScroll: true });

  const deadline = view.performance.now() + TIMEOUT_MS;
  let timer: number;
  let composing = false;
  proxy.addEventListener("compositionstart", () => {
    composing = true;
  });
  proxy.addEventListener("compositionend", () => {
    composing = false;
  });

  const cleanup = () => {
    view.clearTimeout(timer);
    proxy.remove();
  };

  const check = () => {
    if (document.activeElement !== proxy || view.performance.now() >= deadline) {
      cleanup();
      return;
    }
    const editor =
      !composing && drawerClosed(document) ? document.querySelector<HTMLElement>(EDITOR) : null;
    if (editor !== null) {
      const text = proxy.value;
      editor.focus({ preventScroll: true });
      if (editor.contains(document.activeElement)) {
        // Use the browser's editing operation so the composer gets a native
        // input event and applies the edit at its selection with normal undo.
        if (text !== "") document.execCommand("insertText", false, text);
        return;
      }
    }
    if (document.activeElement === proxy) timer = view.setTimeout(check, RETRY_MS);
  };

  proxy.addEventListener("blur", cleanup, { once: true });
  timer = view.setTimeout(check, SETTLE_MS);
}

/** The drawer is shut and still, or there is no drawer (a desktop layout). */
function drawerClosed(document: Document): boolean {
  const inset = document.querySelector(INSET);
  if (inset === null) return true;
  return (
    inset.getAttribute("data-sidebar-shelf") !== "open" && !inset.hasAttribute("data-vaul-animate")
  );
}
