import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { SVGSpriteSheet } from "@pierre/diffs";

const PANEL = ":is(#thread-detail-secondary-panel, [data-secondary-panel-shelf])";
const HEADER = `${PANEL} .bg-background > .flex:has(> span > button[aria-expanded])`;
// bb's diff toolbar, or a plugin list that opts in (gitbutler's file cards).
const DIFF_VIEW = '[data-testid="git-diff-toolbar-layout"], [data-monokai-diff-surface]';
const WATCHED = `${HEADER}, ${DIFF_VIEW}`;
const ICONS = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "moved",
  copied: "moved",
} as const;
type Kind = keyof typeof ICONS;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  typeof value === "object" && value !== null ? (value as RecordValue) : null;

// The SDK's diff renderer owns the body only. Read the header model at the
// host boundary, without depending on component names or hook positions.
export function readHeaderKind(element: Element): Kind | null {
  const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
  let fiber = key ? record((element as unknown as RecordValue)[key]) : null;
  const propsKey = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
  const props = propsKey ? record((element as unknown as RecordValue)[propsKey]) : null;
  if (!props) return null;
  if (fiber?.memoizedProps !== props) fiber = record(fiber?.alternate);
  if (fiber?.memoizedProps !== props) return null;
  for (let depth = 0; fiber && depth < 40; depth++, fiber = record(fiber.return)) {
    const model = record(record(fiber.memoizedProps)?.model);
    if (!model) continue;
    const kind = model.changeKind;
    return typeof model.path === "string" &&
      typeof model.label === "string" &&
      typeof kind === "string" &&
      Object.hasOwn(ICONS, kind)
      ? (kind as Kind)
      : null;
  }
  return null;
}

// Each tagged element carries exactly one of these attributes.
function diffTags(headers: Element[]): Map<Element, string> {
  const tags = new Map<Element, string>();
  const panels = new Map<Element, boolean>();
  for (const header of headers) {
    tags.set(header, "data-monokai-diff-header");
    const shell = header.parentElement!;
    tags.set(shell, "data-monokai-diff-shell");
    // bb renders a sticky header's sentinel before its shell, inside the card.
    if (shell.previousElementSibling?.matches(".h-0") && shell.parentElement)
      tags.set(shell.parentElement, "data-monokai-diff-card");
    const panel = header.closest(PANEL)!;
    if (!panels.has(panel)) panels.set(panel, panel.querySelector(DIFF_VIEW) !== null);
    if (panels.get(panel)) tags.set(panel, "data-monokai-diff-panel");
  }
  return tags;
}

export function mountDiffHeader({ signal }: PluginContentScriptContext) {
  const sprites = new DOMParser().parseFromString(SVGSpriteSheet, "text/html");
  const owned = new Map<Element, SVGSVGElement>();
  // Tag each header, its shell and card, and a panel that shows a diff, so the
  // theme and diff-header.css can style them without a page-wide :has().
  let tags = new Map<Element, string>();
  const filenames = new Set<Element>();
  const resizeObserver = new ResizeObserver((entries) => {
    // Finish layout reads before changing attributes. Header decoration must
    // not force a style/layout pass once per filename while rows are loading.
    const measurements = entries.map(({ target }) => ({
      target,
      overflow: target.scrollWidth > target.clientWidth,
    }));
    for (const { target, overflow } of measurements)
      target.toggleAttribute("data-monokai-filename-overflow", overflow);
  });
  const observeFilename = (element: Element) => {
    if (filenames.has(element)) return;
    filenames.add(element);
    resizeObserver.observe(element);
  };
  let frame: number | null = null;
  let disposed = false;
  const reconcile = () => {
    frame = null;
    if (disposed) return;
    const active =
      getComputedStyle(document.documentElement).getPropertyValue("--bb-monokai-active").trim() ===
      "1";
    document.documentElement.toggleAttribute("data-monokai-diff-headers", active);
    filenames.forEach((element) => {
      if (!active || !element.isConnected) {
        element.removeAttribute("data-monokai-filename-overflow");
        resizeObserver.unobserve(element);
        filenames.delete(element);
      }
    });
    const headers = active ? [...document.querySelectorAll(HEADER)] : [];
    const next = diffTags(headers);
    tags.forEach((name, element) => {
      if (next.get(element) !== name) element.removeAttribute(name);
    });
    next.forEach((name, element) => element.toggleAttribute(name, true));
    tags = next;
    // Icons live only on tagged headers.
    owned.forEach((icon, header) => {
      if (next.has(header)) return;
      icon.remove();
      owned.delete(header);
    });
    for (const header of headers) {
      header.querySelectorAll(".truncate").forEach(observeFilename);
      const kind = readHeaderKind(header);
      const prior = owned.get(header);
      if (!kind) {
        prior?.remove();
        owned.delete(header);
        continue;
      }
      if (prior?.dataset.monokaiDiffKind === kind && prior.isConnected) continue;
      prior?.remove();
      const target = header.querySelector(":scope > span > span");
      const symbol = sprites.getElementById(`diffs-icon-symbol-${ICONS[kind]}`);
      if (!target || !symbol) continue;
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 16 16");
      icon.setAttribute("role", "img");
      icon.setAttribute("aria-label", `${kind} file`);
      icon.dataset.monokaiDiffKind = kind;
      for (const child of symbol.children) icon.append(child.cloneNode(true));
      target.prepend(icon);
      owned.set(header, icon);
    }
  };
  const schedule = () => {
    if (!disposed && frame === null) frame = requestAnimationFrame(reconcile);
  };
  const containsWatched = (node: Node) =>
    node instanceof Element && (node.matches(WATCHED) || node.querySelector(WATCHED) !== null);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "characterData" && mutation.type !== "childList") continue;
      const target =
        mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      const filename = target?.closest(".truncate");
      if (!filename || !filenames.has(filename)) continue;
      // A new path can overflow without changing the element's box size.
      resizeObserver.unobserve(filename);
      resizeObserver.observe(filename);
    }
    if (
      mutations.some((mutation) => {
        const changed = [...mutation.addedNodes, ...mutation.removedNodes];
        if (
          changed.length &&
          changed.every(
            (node) => node instanceof Element && node.hasAttribute("data-monokai-diff-kind"),
          )
        )
          return false;
        const target =
          mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return (
          target === document.documentElement ||
          document.head.contains(target) ||
          Boolean(target?.closest(HEADER)) ||
          changed.some(containsWatched)
        );
      })
    )
      schedule();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-expanded", "aria-label"],
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  document.addEventListener("load", schedule, true);
  const dispose = () => {
    disposed = true;
    observer.disconnect();
    resizeObserver.disconnect();
    for (const element of filenames) element.removeAttribute("data-monokai-filename-overflow");
    filenames.clear();
    document.removeEventListener("load", schedule, true);
    signal.removeEventListener("abort", dispose);
    if (frame !== null) cancelAnimationFrame(frame);
    for (const icon of owned.values()) icon.remove();
    owned.clear();
    tags.forEach((name, element) => element.removeAttribute(name));
    tags.clear();
    document.documentElement.removeAttribute("data-monokai-diff-headers");
  };
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) dispose();
  else schedule();
  return dispose;
}
