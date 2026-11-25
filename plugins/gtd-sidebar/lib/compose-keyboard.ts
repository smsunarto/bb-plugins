/**
 * Opens the phone keyboard on the New thread composer once the drawer has
 * closed.
 *
 * bb's `toCompose({ focusPrompt: true })` skips focusing under a coarse
 * pointer, and iOS raises the keyboard only for a focus that starts inside
 * the tap itself (bb's iOS WebView keeps keyboardDisplayRequiresUserAction).
 * The composer mounts frames later, and the drawer takes about 350ms to slide
 * shut. So, during the tap, focus a hidden textarea with `inputmode="none"`,
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
const SHELF = "data-sidebar-shelf";
const ANIMATING = "data-vaul-animate";
const handoffs = new WeakMap<Document, () => void>();

export function cancelComposeKeyboardHandoff(document: Document): void {
  handoffs.get(document)?.();
}

/** Call synchronously from the tap's handler, before navigating. */
export function focusComposeEditorWithKeyboard(document: Document): void {
  const view = document.defaultView;
  if (view === null) return;
  cancelComposeKeyboardHandoff(document);
  const inset = document.querySelector(INSET);
  if (inset === null) return;

  const proxy = document.createElement("textarea");
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

  let settled = false;
  let composing = false;
  let stopTransfer: (() => void) | undefined;

  const canHandoff = () =>
    settled &&
    !composing &&
    document.activeElement === proxy &&
    inset.getAttribute(SHELF) !== "open" &&
    !inset.hasAttribute(ANIMATING);

  const focusEditor = () => {
    inset.querySelector<HTMLElement>(EDITOR)?.focus({ preventScroll: true });
  };

  const check = () => {
    if (canHandoff()) focusEditor();
  };

  const observer = new view.MutationObserver((records) => {
    if (
      canHandoff() &&
      records.some(({ target, addedNodes, type }) => {
        if (type === "attributes") {
          return target === inset || (target instanceof view.Element && target.matches(EDITOR));
        }
        return Array.from(addedNodes).some(
          (node) =>
            node instanceof view.Element && (node.matches(EDITOR) || node.querySelector(EDITOR)),
        );
      })
    ) {
      focusEditor();
    }
  });
  observer.observe(inset, {
    subtree: true,
    childList: true,
    attributeFilter: [SHELF, ANIMATING, "contenteditable"],
  });

  const settle = view.setTimeout(() => {
    settled = true;
    check();
  }, SETTLE_MS);
  const expiry = view.setTimeout(() => cleanup(), TIMEOUT_MS);
  const cleanup = () => {
    observer.disconnect();
    view.clearTimeout(settle);
    view.clearTimeout(expiry);
    stopTransfer?.();
    handoffs.delete(document);
    proxy.removeEventListener("blur", onBlur);
    proxy.remove();
  };

  // Also catches the host focusing the editor before the drawer check runs.
  const onBlur = ({ relatedTarget }: FocusEvent) => {
    const editor = relatedTarget instanceof view.Element ? relatedTarget.closest(EDITOR) : null;
    const text = proxy.value;
    if (text === "" || editor === null || !inset.contains(editor)) {
      cleanup();
      return;
    }

    // A trusted click or Tab can run microtasks between blur and focusin.
    // Wait for focus, then let the browser finish placing its caret.
    let transfer: number | undefined;
    const insert = () => {
      cleanup();
      if (!editor.contains(document.activeElement)) return;
      // Keep the existing draft and append the text buffered before focus.
      document.getSelection()?.collapse(editor, editor.childNodes.length);
      if (
        text.includes("\n") &&
        typeof view.DataTransfer === "function" &&
        typeof view.ClipboardEvent === "function"
      ) {
        // Let rich-text composers interpret line breaks as they do on paste.
        const clipboardData = new view.DataTransfer();
        clipboardData.setData("text/plain", text);
        const paste = new view.ClipboardEvent("paste", {
          clipboardData,
          bubbles: true,
          cancelable: true,
        });
        if (!editor.dispatchEvent(paste)) return;
      }
      document.execCommand("insertText", false, text);
    };
    const onFocus = () => {
      transfer = view.setTimeout(insert);
    };
    stopTransfer = () => {
      editor.removeEventListener("focusin", onFocus);
      view.clearTimeout(transfer);
    };
    editor.addEventListener("focusin", onFocus, { once: true });
  };

  handoffs.set(document, cleanup);
  proxy.addEventListener("blur", onBlur, { once: true });
  proxy.addEventListener("compositionstart", () => {
    composing = true;
  });
  proxy.addEventListener("compositionend", () => {
    composing = false;
    view.queueMicrotask(check);
  });
}
