import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { SVGSpriteSheet } from "@pierre/diffs";

const HEADER =
  ":is(#thread-detail-secondary-panel, [data-secondary-panel-shelf]) .bg-background > .flex:has(> span > button[aria-expanded])";
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

export function mountDiffHeader({ signal }: PluginContentScriptContext) {
  const sprites = new DOMParser().parseFromString(SVGSpriteSheet, "text/html");
  const owned = new Map<Element, SVGSVGElement>();
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
    for (const [header, icon] of owned) {
      if (!active || !header.isConnected || !header.matches(HEADER)) {
        icon.remove();
        owned.delete(header);
      }
    }
    if (!active) return;
    for (const header of document.querySelectorAll(HEADER)) {
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
  const containsHeader = (node: Node) =>
    node instanceof Element && (node.matches(HEADER) || node.querySelector(HEADER) !== null);
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
          changed.some(containsHeader)
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
    document.documentElement.removeAttribute("data-monokai-diff-headers");
  };
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) dispose();
  else schedule();
  return dispose;
}
