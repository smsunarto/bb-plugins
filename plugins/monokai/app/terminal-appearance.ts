import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

const ACTIVE_MOUNT = Symbol.for("bb.monokai.terminal-appearance.active-mount");
const MAX_FIBER_DEPTH = 40;
const MAX_HOOKS = 128;

type RecordValue = Record<string, unknown>;
type TerminalTheme = Record<string, unknown>;

interface TerminalOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  theme: TerminalTheme;
}

export interface TerminalAppearance {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  background: string;
}

export interface TerminalBinding {
  terminal: {
    element: Element;
    options: TerminalOptions;
    rows: number;
    refresh(start: number, end: number): void;
  };
  fit(): void;
}

interface AppliedTerminal {
  appearance: TerminalAppearance;
  restore(): void;
}

function record(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null ? (value as RecordValue) : null;
}

function bindingFromRef(value: unknown, element: Element): TerminalBinding | null {
  const terminal = record(value);
  const options = record(terminal?.options);
  if (
    terminal?.element !== element ||
    typeof terminal.refresh !== "function" ||
    typeof terminal.rows !== "number" ||
    typeof options?.fontFamily !== "string" ||
    typeof options.fontSize !== "number" ||
    typeof options.lineHeight !== "number" ||
    !record(options.theme)
  )
    return null;

  const addons = record(terminal._addonManager)?._addons;
  if (!Array.isArray(addons)) return null;
  const fit = addons
    .map((addon: unknown) => record(record(addon)?.instance))
    .find(
      (addon) =>
        addon?._terminal === terminal &&
        typeof addon.fit === "function" &&
        typeof addon.proposeDimensions === "function",
    );
  if (!fit) return null;

  // These are the only private lookups. Once recognized, use xterm's public
  // options and the already-loaded FitAddon so BB retains grid-size ownership.
  return {
    terminal: terminal as unknown as TerminalBinding["terminal"],
    fit: () => (fit.fit as () => void).call(fit),
  };
}

export function findTerminalBinding(fiberValue: unknown, element: Element): TerminalBinding | null {
  let fiber = record(fiberValue);
  for (let depth = 0; fiber && depth < MAX_FIBER_DEPTH; depth++, fiber = record(fiber.return)) {
    let hook = record(fiber.memoizedState);
    for (let index = 0; hook && index < MAX_HOOKS; index++, hook = record(hook.next)) {
      const binding = bindingFromRef(record(hook.memoizedState)?.current, element);
      if (binding) return binding;
    }
  }
  return null;
}

function findElementBinding(element: Element): TerminalBinding | null {
  let parent: Element | null = element;
  for (let depth = 0; parent && depth < 8; depth++, parent = parent.parentElement) {
    const key = Object.keys(parent).find((name) => name.startsWith("__reactFiber$"));
    if (!key) continue;
    const binding = findTerminalBinding(Reflect.get(parent, key), element);
    if (binding) return binding;
  }
  return null;
}

export function applyTerminalAppearance(
  { terminal, fit }: TerminalBinding,
  appearance: TerminalAppearance,
): () => void {
  const options = terminal.options;
  const previous = {
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    lineHeight: options.lineHeight,
    background: options.theme.background,
    cursorAccent: options.theme.cursorAccent,
  };
  const restore = () => {
    // Restore only values we still own. Another theme may already have changed
    // the colors by the time its stylesheet mutation reaches this script.
    if (options.fontFamily === appearance.fontFamily) options.fontFamily = previous.fontFamily;
    if (options.fontSize === appearance.fontSize) options.fontSize = previous.fontSize;
    if (options.lineHeight === appearance.lineHeight) options.lineHeight = previous.lineHeight;
    const theme = { ...options.theme };
    if (theme.background === appearance.background) theme.background = previous.background;
    if (theme.cursorAccent === appearance.background) theme.cursorAccent = previous.cursorAccent;
    options.theme = theme;
    fit();
    terminal.refresh(0, terminal.rows - 1);
  };
  try {
    options.fontFamily = appearance.fontFamily;
    options.fontSize = appearance.fontSize;
    options.lineHeight = appearance.lineHeight;
    options.theme = {
      ...options.theme,
      background: appearance.background,
      cursorAccent: appearance.background,
    };
    fit();
    terminal.refresh(0, terminal.rows - 1);
  } catch (error) {
    try {
      restore();
    } catch {
      /* The terminal can disappear during application. */
    }
    throw error;
  }
  return restore;
}

function readAppearance(): TerminalAppearance | null {
  const style = getComputedStyle(document.documentElement);
  if (style.getPropertyValue("--bb-monokai-active").trim() !== "1") return null;
  const fontFamily = style.getPropertyValue("--terminal-font-family").trim();
  const fontSize = Number(style.getPropertyValue("--terminal-font-size"));
  const lineHeight = Number(style.getPropertyValue("--terminal-line-height"));
  const background = style.getPropertyValue("--terminal-background").trim();
  if (
    !fontFamily ||
    !background ||
    !Number.isFinite(fontSize) ||
    fontSize <= 0 ||
    !Number.isFinite(lineHeight) ||
    lineHeight < 1
  )
    return null;
  return { fontFamily, fontSize, lineHeight, background };
}

function sameAppearance(left: TerminalAppearance, right: TerminalAppearance): boolean {
  return (
    left.fontFamily === right.fontFamily &&
    left.fontSize === right.fontSize &&
    left.lineHeight === right.lineHeight &&
    left.background === right.background
  );
}

function relevantNode(node: Node): boolean {
  if (!(node instanceof Element)) return node.parentElement?.tagName === "STYLE";
  return (
    node.matches(".xterm, style, link[rel=stylesheet]") ||
    node.querySelector(".xterm, style, link[rel=stylesheet]") !== null
  );
}

export function mountTerminalAppearance({ signal }: PluginContentScriptContext): () => void {
  const registry = globalThis as typeof globalThis & { [ACTIVE_MOUNT]?: () => void };
  registry[ACTIVE_MOUNT]?.();
  const applied = new Map<Element, AppliedTerminal>();
  let frame: number | null = null;
  let disposed = false;
  const restore = (entry: AppliedTerminal) => {
    try {
      entry.restore();
    } catch {
      /* xterm may have been disposed with its pane. */
    }
  };
  const reconcile = () => {
    frame = null;
    if (disposed) return;
    const appearance = readAppearance();
    for (const [element, entry] of applied) {
      if (element.isConnected && appearance && sameAppearance(entry.appearance, appearance))
        continue;
      restore(entry);
      applied.delete(element);
    }
    if (!appearance) return;
    for (const element of document.querySelectorAll(".xterm")) {
      if (applied.has(element)) continue;
      const binding = findElementBinding(element);
      if (!binding) continue;
      try {
        applied.set(element, { appearance, restore: applyTerminalAppearance(binding, appearance) });
      } catch {
        /* Skip an unavailable or concurrently disposed terminal. */
      }
    }
  };
  const schedule = () => {
    if (!disposed && frame === null) frame = requestAnimationFrame(reconcile);
  };
  const observer = new MutationObserver((records) => {
    if (
      records.some(
        (mutation) =>
          mutation.target === document.documentElement ||
          mutation.target instanceof HTMLStyleElement ||
          [...mutation.addedNodes, ...mutation.removedNodes].some(relevantNode),
      )
    )
      schedule();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  observer.observe(document.head, { childList: true, characterData: true, subtree: true });
  observer.observe(document.body, { childList: true, subtree: true });
  const onLoad = (event: Event) => {
    if (event.target instanceof HTMLLinkElement) schedule();
  };
  document.addEventListener("load", onLoad, true);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    observer.disconnect();
    document.removeEventListener("load", onLoad, true);
    if (frame !== null) cancelAnimationFrame(frame);
    for (const entry of applied.values()) restore(entry);
    applied.clear();
    if (registry[ACTIVE_MOUNT] === dispose) delete registry[ACTIVE_MOUNT];
  };
  registry[ACTIVE_MOUNT] = dispose;
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) dispose();
  else schedule();
  return dispose;
}
