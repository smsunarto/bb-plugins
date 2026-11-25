/**
 * Keeps the Captains projects out of the new-thread composer's project picker, and only that
 * picker: BB renders the same ProjectSelector elsewhere, such as Settings → Archived threads,
 * which keeps listing Captains. BB's picker takes its list from BB's own project query and has
 * no plugin hook to filter it, so this hides the rows in BB's DOM.
 *
 * A picker container BB shows while the new-thread footer's project button is open is marked
 * as the new-thread picker. One marked `<style>` hides each hidden project's row inside marked
 * containers, and only marked containers are observed: their hidden rows get
 * `aria-disabled="true"` so the keyboard skips them.
 *
 * It depends on BB's ProjectSelector DOM (apps/app/src/components/pickers/ProjectSelector.tsx
 * and NewThreadPromptBox.tsx in get-bb/bb, as of bb 0.50.1):
 * - the new-thread picker's button is `[data-new-thread-footer] [data-promptbox-project-control]`,
 *   with `aria-expanded="true"` while it is open;
 * - on desktop the button's `aria-controls` names the popover, `[role="dialog"]
 *   [aria-label="Project"]`, inside a Radix `[data-radix-popper-content-wrapper]` on `<body>`;
 * - on phones the list sits in `div[aria-label="Project"]` inside a persistent drawer
 *   (`[data-persistent-drawer-content]` on `<body>`, `data-state="open"` while shown). The
 *   button has no `aria-controls` there; the drawer joins `<body>` empty on the first open and
 *   stays mounted for later opens, so drawers are matched to the button when they open;
 * - the list is a cmdk root directly inside the `Project`-labelled element, and each project
 *   row is a `[cmdk-item]` whose `data-value` is the project id;
 * - cmdk 1.1 skips `aria-disabled="true"` rows when it highlights a search's first match and on
 *   arrow keys, and Home highlights the first enabled row. BB renders `aria-disabled="false"`
 *   and never changes it for a project row, so React does not write it back. A row that mounts
 *   in the same update as a search change (type "Capz", then Backspace) is highlighted before it
 *   is disabled: the script then sends cmdk a Home key, and stops Enter on a hidden highlighted
 *   row in case no enabled row is left.
 * If BB changes any of these, the rows show again and the composer's fallback still moves a
 * new thread off a hidden project; README.md lists the same dependency.
 */
import { hiddenProjectIds, subscribeHiddenProjectIds } from "./hidden-projects";

const STYLE_MARK = "data-t3-captain-projects-style";
/** On the `<body>` child that holds the new-thread composer's project picker. */
const PICKER = "data-t3-new-thread-projects";
/** On a row this script disabled, so a later pass or the disposer can undo it. */
const HIDDEN = "data-t3-hidden-project";
const LIST = '[aria-label="Project"] > [cmdk-root]';
const ROW = "[cmdk-item]";
const OPEN_TRIGGER =
  '[data-new-thread-footer] [data-promptbox-project-control][aria-expanded="true"]';
const POPOVER = "data-radix-popper-content-wrapper";
const DRAWER = "data-persistent-drawer-content";

/** One rule per hidden project, scoped to the new-thread picker's list. */
export function hiddenProjectsCss(ids: readonly string[]): string {
  return ids
    .map(
      (id) =>
        `[${PICKER}] ${LIST} ${ROW}[data-value=${JSON.stringify(id)}] { display: none !important; }`,
    )
    .join("\n");
}

/** Whether `container`, a `<body>` child, holds the open new-thread project picker. */
function isNewThreadPicker(container: Element): boolean {
  if (container.hasAttribute(DRAWER) && container.getAttribute("data-state") === "closed") {
    return false;
  }
  const trigger = container.ownerDocument.querySelector(OPEN_TRIGGER);
  if (trigger === null) return false;
  const controls = trigger.getAttribute("aria-controls");
  if (controls !== null) {
    const popover = container.ownerDocument.getElementById(controls);
    return popover !== null && container.contains(popover);
  }
  return container.hasAttribute(DRAWER);
}

function rowsIn(node: Element): Element[] {
  const rows = node.matches(ROW) ? [node] : [...node.querySelectorAll(ROW)];
  return rows.filter((row) => row.closest(LIST) !== null);
}

function untag(row: Element) {
  row.removeAttribute(HIDDEN);
  row.setAttribute("aria-disabled", "false");
}

/** Disables `rows` that are hidden and restores those no longer hidden. */
function tagRows(rows: Iterable<Element>, hidden: ReadonlySet<string>) {
  for (const row of rows) {
    const hide = hidden.has(row.getAttribute("data-value") ?? "");
    if (hide === row.hasAttribute(HIDDEN)) continue;
    if (hide) {
      row.setAttribute(HIDDEN, "");
      row.setAttribute("aria-disabled", "true");
    } else untag(row);
  }
}

/** Moves cmdk's highlight off a hidden row to the first enabled row. */
function unstrandHighlight(picker: Element) {
  for (const list of picker.querySelectorAll(LIST)) {
    if (list.querySelector(`${ROW}[aria-selected="true"][${HIDDEN}]`) === null) continue;
    list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
    );
  }
}

/** Stops Enter from picking a hidden row that holds cmdk's highlight. */
function stopHiddenEnter(event: Event) {
  if (!(event instanceof KeyboardEvent) || event.key !== "Enter" || event.isComposing) return;
  const picker = event.currentTarget;
  if (!(picker instanceof Element)) return;
  if (picker.querySelector(`${LIST} ${ROW}[aria-selected="true"][${HIDDEN}]`) === null) return;
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Hides the published Captains projects in the new-thread project picker until `signal`
 * aborts; the disposer removes the stylesheet and restores everything it marked.
 */
export function mountProjectPickerHide(document: Document, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};
  const style = document.createElement("style");
  style.setAttribute(STYLE_MARK, "");
  document.head.append(style);

  let hidden = new Set<string>();
  /** The new-thread picker containers, each with an observer for the rows it adds. */
  const pickers = new Map<Element, MutationObserver>();
  /** Persistent drawers not yet matched to the new-thread button, watched for opening. */
  const drawers = new Map<Element, MutationObserver>();

  const apply = () => {
    const ids = hiddenProjectIds();
    hidden = new Set(ids);
    style.textContent = hiddenProjectsCss(ids);
    for (const picker of pickers.keys()) {
      tagRows(rowsIn(picker), hidden);
      unstrandHighlight(picker);
    }
  };

  const watchPicker = (picker: Element) => {
    if (pickers.has(picker)) return;
    drawers.get(picker)?.disconnect();
    drawers.delete(picker);
    picker.setAttribute(PICKER, "");
    const observer = new MutationObserver((records) => {
      if (hidden.size === 0) return;
      let added = false;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          tagRows(rowsIn(node), hidden);
          added = true;
        }
      }
      if (added) unstrandHighlight(picker);
    });
    observer.observe(picker, { subtree: true, childList: true });
    picker.addEventListener("keydown", stopHiddenEnter, true);
    pickers.set(picker, observer);
    tagRows(rowsIn(picker), hidden);
  };

  /** Matches a `<body>` child now, or, for a drawer, each time it opens. */
  const consider = (node: Node) => {
    if (!(node instanceof Element) || pickers.has(node)) return;
    const isDrawer = node.hasAttribute(DRAWER);
    if (!isDrawer && !node.hasAttribute(POPOVER)) return;
    if (isNewThreadPicker(node)) {
      watchPicker(node);
      return;
    }
    if (!isDrawer || drawers.has(node)) return;
    const observer = new MutationObserver(() => {
      if (isNewThreadPicker(node)) watchPicker(node);
    });
    observer.observe(node, { attributes: true, attributeFilter: ["data-state"] });
    drawers.set(node, observer);
  };

  const release = (node: Element) => {
    drawers.get(node)?.disconnect();
    drawers.delete(node);
    const observer = pickers.get(node);
    if (observer === undefined) return;
    observer.disconnect();
    node.removeEventListener("keydown", stopHiddenEnter, true);
    node.removeAttribute(PICKER);
    for (const row of node.querySelectorAll(`[${HIDDEN}]`)) untag(row);
    pickers.delete(node);
  };

  const body = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) consider(node);
      for (const node of record.removedNodes) if (node instanceof Element) release(node);
    }
  });
  body.observe(document.body, { childList: true });
  const unsubscribe = subscribeHiddenProjectIds(apply);
  apply();
  for (const child of document.body.children) consider(child);

  const dispose = () => {
    body.disconnect();
    unsubscribe();
    for (const node of [...pickers.keys(), ...drawers.keys()]) release(node);
    style.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return () => {
    signal.removeEventListener("abort", dispose);
    dispose();
  };
}
