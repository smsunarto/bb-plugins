import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

const TOAST = "[data-sonner-toast]";
const MARK = "data-monokai-archive-toast";
const DESCRIPTION = "data-monokai-archive-description";

/** Tag only archive confirmations with Undo; other notifications retain their details. */
export function mountArchiveToast({ signal }: Pick<PluginContentScriptContext, "signal">) {
  const marked = new Set<Element>();

  function clear(toast: Element) {
    toast.removeAttribute(MARK);
    for (const description of toast.querySelectorAll(`[${DESCRIPTION}]`))
      description.removeAttribute(DESCRIPTION);
    marked.delete(toast);
  }

  function reconcile(toast: Element) {
    clear(toast);
    const title = toast.querySelector('[data-testid="app-toast-title"]')?.textContent?.trim();
    const undo = Array.from(toast.querySelectorAll("button")).some(
      (button) => button.textContent?.trim() === "Undo",
    );
    if ((title !== "Thread archived" && title !== "Threads archived") || !undo) return;
    toast.setAttribute(MARK, "");
    toast
      .querySelector('[data-testid="app-toast-description"]')
      ?.parentElement?.setAttribute(DESCRIPTION, "");
    marked.add(toast);
  }

  function inspect(node: Node) {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return;
    const toast = element.closest(TOAST);
    if (toast) reconcile(toast);
    else for (const child of element.querySelectorAll(TOAST)) reconcile(child);
  }

  // One initial document scan. Subsequent work stays inside changed subtrees.
  for (const toast of document.querySelectorAll(TOAST)) reconcile(toast);
  const observer = new MutationObserver((records) => {
    for (const toast of marked) if (!toast.isConnected) clear(toast);
    for (const record of records) {
      const element =
        record.target instanceof Element ? record.target : record.target.parentElement;
      const toast = element?.closest(TOAST);
      if (toast) reconcile(toast);
      else for (const node of record.addedNodes) inspect(node);
    }
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  const dispose = () => {
    observer.disconnect();
    for (const toast of marked) clear(toast);
    signal.removeEventListener("abort", dispose);
  };
  if (signal.aborted) dispose();
  else signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
