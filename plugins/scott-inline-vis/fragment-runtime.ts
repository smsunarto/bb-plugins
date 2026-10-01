import { FRAGMENT_STYLES } from "./fragment-styles.ts";

/**
 * HTML fragments (no doctype, html, head, or body tag) render inside bb's
 * visualization runtime: theme tokens, utility classes, icons, tooltips, tabs,
 * variant carousels, content-sized height, saved state, and follow-up prompts.
 * Full documents keep rendering exactly as written.
 */
export function isFragment(html: string): boolean {
  // Tag-like text inside comments, scripts, and styles is not markup.
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1\s*>/giu, "");
  return !/<(?:!doctype|html|head|body)[\s>]/iu.test(markup);
}

/** Host CSS variables copied into the frame. Fragment styles derive everything else. */
export const THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--radius",
  "--font-sans",
  "--font-mono",
  "--ansi-1",
  "--ansi-2",
  "--ansi-3",
  "--ansi-4",
  "--ansi-5",
  "--ansi-6",
] as const;

export interface HostTheme {
  scheme: "light" | "dark";
  tokens: Record<string, string>;
}

export function readHostTheme(element: Element): HostTheme {
  const style = getComputedStyle(element);
  const tokens: Record<string, string> = {};
  for (const name of THEME_TOKENS) {
    const value = style.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  const scheme = element.ownerDocument.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
  return { scheme, tokens };
}

export function sameTheme(a: HostTheme, b: HostTheme): boolean {
  return a.scheme === b.scheme && THEME_TOKENS.every((name) => a.tokens[name] === b.tokens[name]);
}

export const FRAGMENT_MESSAGES = {
  resize: "bb:inline-vis:resize",
  state: "bb:inline-vis:state",
  followUp: "bb:inline-vis:follow-up",
  theme: "bb:inline-vis:theme",
} as const;

export const MAX_WIDGET_STATE_BYTES = 16 * 1024;
export const LUCIDE_URL = "https://unpkg.com/lucide@1.49.0/dist/umd/lucide.min.js";

export type FrameMessage =
  | { type: "resize"; height: number }
  | { type: "state"; state: string }
  | { type: "followUp"; prompt: string };

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Parse an untrusted frame message. The frame runs agent-written code. */
export function parseFrameMessage(data: unknown, token: string): FrameMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.token !== token) return null;
  switch (message.type) {
    case FRAGMENT_MESSAGES.resize:
      return typeof message.height === "number" && Number.isFinite(message.height)
        ? { type: "resize", height: Math.max(0, Math.ceil(message.height)) }
        : null;
    case FRAGMENT_MESSAGES.state:
      return typeof message.state === "string" &&
        new Blob([message.state]).size <= MAX_WIDGET_STATE_BYTES &&
        isJson(message.state)
        ? { type: "state", state: message.state }
        : null;
    case FRAGMENT_MESSAGES.followUp:
      return typeof message.prompt === "string" && message.prompt.trim()
        ? { type: "followUp", prompt: message.prompt.trim().slice(0, 4_000) }
        : null;
    default:
      return null;
  }
}

interface RuntimeConfig {
  token: string;
  theme: HostTheme;
  /** JSON text of the saved widget state, or null. */
  state: string | null;
  messages: typeof FRAGMENT_MESSAGES;
  lucideUrl: string;
  maxStateBytes: number;
}

/** Add the stylesheet and runtime to a parsed fragment document's head. */
export function injectFragmentRuntime(
  document: Document,
  config: Omit<RuntimeConfig, "messages" | "lucideUrl" | "maxStateBytes">,
): void {
  const style = document.createElement("style");
  style.textContent = FRAGMENT_STYLES;
  const script = document.createElement("script");
  const json = JSON.stringify({
    ...config,
    messages: FRAGMENT_MESSAGES,
    lucideUrl: LUCIDE_URL,
    maxStateBytes: MAX_WIDGET_STATE_BYTES,
  } satisfies RuntimeConfig).replace(/</gu, "\\u003c");
  script.textContent = `(${fragmentRuntime.toString()})(${json});`;
  // The runtime must define `window.bb` before any fragment script runs.
  document.head.prepend(style, script);
}

/**
 * Runs inside the opaque frame, serialized with `Function.prototype.toString`.
 * It must stay self-contained: no imports, no module-scope references, and no
 * build helpers. `fragment-runtime.test.ts` evaluates the serialized source.
 * That is also why its sections are closures rather than separate functions.
 */
// oxlint-disable-next-line complexity/complexity
function fragmentRuntime(config: RuntimeConfig): void {
  const root = document.documentElement;
  const post = (type: string, payload: Record<string, unknown>) =>
    parent.postMessage({ type, token: config.token, ...payload }, "*");

  const applyTheme = (theme: HostTheme) => {
    for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(name, value);
    root.style.colorScheme = theme.scheme;
    root.dataset.theme = theme.scheme;
  };
  applyTheme(config.theme);
  addEventListener("message", (event) => {
    const data = event.data as { type?: string; token?: string; theme?: HostTheme } | null;
    if (event.source !== parent || data?.token !== config.token) return;
    if (data.type === config.messages.theme && data.theme) applyTheme(data.theme);
  });

  // Saved state and follow-up prompts.
  let state: unknown = null;
  try {
    state = config.state === null ? null : JSON.parse(config.state);
  } catch {
    // A malformed stored snapshot must not keep the fragment from loading.
  }
  const bb = {
    get widgetState() {
      return state;
    },
    async setWidgetState(next: unknown) {
      const text = JSON.stringify(next ?? null);
      if (new Blob([text]).size > config.maxStateBytes) {
        throw new Error(`Widget state exceeds ${config.maxStateBytes} bytes.`);
      }
      state = JSON.parse(text);
      post(config.messages.state, { state: text });
    },
    async sendFollowUp(prompt: string) {
      if (typeof prompt !== "string" || !prompt.trim()) {
        throw new Error("sendFollowUp needs a non-empty prompt.");
      }
      post(config.messages.followUp, { prompt });
    },
  };
  Object.defineProperty(window, "bb", { value: Object.freeze(bb) });

  // Content-sized height. The parent clamps it. An open tooltip is fixed, so
  // it adds no body height; count it so a short frame grows to show it.
  let frame = 0;
  let tooltip: HTMLDivElement | null = null;
  const reportHeight = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!document.body) return;
      const tooltipHeight = tooltip?.isConnected ? tooltip.getBoundingClientRect().height + 8 : 0;
      const height = Math.max(document.body.getBoundingClientRect().height, tooltipHeight);
      post(config.messages.resize, { height });
    });
  };

  // Lucide icons: `<i data-lucide="name">` placeholders, including ones added later.
  const PENDING = "data-bb-icon-pending";
  let lucide: Promise<unknown> | null = null;
  const loadLucide = () =>
    (lucide ??= new Promise((resolve, reject) => {
      const element = document.createElement("script");
      element.src = config.lucideUrl;
      element.addEventListener("load", resolve);
      element.addEventListener("error", reject);
      document.head.append(element);
    }));
  // Lucide keeps `data-lucide` on the SVG it creates, so only non-SVG placeholders are pending.
  const renderIcons = async () => {
    if (!document.querySelector("[data-lucide]:not(svg)")) return;
    try {
      await loadLucide();
    } catch {
      console.warn(`inline-vis: failed to load icons from ${config.lucideUrl}`);
      return;
    }
    const api = (window as unknown as { lucide?: { createIcons(options: object): void } }).lucide;
    const pending = document.querySelectorAll("[data-lucide]:not(svg)");
    if (!api || pending.length === 0) return;
    for (const element of pending)
      element.setAttribute(PENDING, element.getAttribute("data-lucide")!);
    api.createIcons({ nameAttr: PENDING, attrs: { width: 16, height: 16 } });
    for (const element of document.querySelectorAll(`[${PENDING}]`))
      element.removeAttribute(PENDING);
  };

  // Tooltips for any `[data-tooltip]` trigger.
  let tooltipTrigger: Element | null = null;
  let tooltipTimer = 0;
  const tooltipId = `bb-tooltip-${config.token}`;
  const hideTooltip = () => {
    clearTimeout(tooltipTimer);
    if (tooltipTrigger) {
      const ids = (tooltipTrigger.getAttribute("aria-describedby") ?? "")
        .split(/\s+/u)
        .filter((id) => id && id !== tooltipId);
      if (ids.length) tooltipTrigger.setAttribute("aria-describedby", ids.join(" "));
      else tooltipTrigger.removeAttribute("aria-describedby");
    }
    tooltipTrigger = null;
    if (tooltip?.isConnected) {
      tooltip.remove();
      reportHeight();
    }
  };
  const showTooltip = (trigger: Element) => {
    const text = trigger.getAttribute("data-tooltip")?.trim();
    if (!text || !trigger.isConnected) return;
    tooltip ??= Object.assign(document.createElement("div"), {
      id: tooltipId,
      className: "tooltip",
    });
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = text;
    document.body.append(tooltip);
    tooltipTrigger = trigger;
    const describedBy = trigger.getAttribute("aria-describedby");
    trigger.setAttribute(
      "aria-describedby",
      describedBy ? `${describedBy} ${tooltipId}` : tooltipId,
    );
    const gap = 6;
    const anchor = trigger.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const fits = {
      top: anchor.top - box.height - gap >= 0,
      bottom: anchor.bottom + box.height + gap <= innerHeight,
      left: anchor.left - box.width - gap >= 0,
      right: anchor.right + box.width + gap <= innerWidth,
    };
    const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" } as const;
    const preferred = trigger.getAttribute("data-tooltip-placement");
    let side: keyof typeof fits =
      preferred === "bottom" || preferred === "left" || preferred === "right" ? preferred : "top";
    if (!fits[side] && fits[opposite[side]]) side = opposite[side];
    let x =
      side === "left"
        ? anchor.left - box.width - gap
        : side === "right"
          ? anchor.right + gap
          : anchor.left + anchor.width / 2 - box.width / 2;
    let y =
      side === "top"
        ? anchor.top - box.height - gap
        : side === "bottom"
          ? anchor.bottom + gap
          : anchor.top + anchor.height / 2 - box.height / 2;
    // Clamp to the far edge first, then the near edge, so a tooltip larger
    // than the frame keeps its first line visible while the frame grows.
    x = Math.max(4, Math.min(x, innerWidth - box.width - 4));
    y = Math.max(4, Math.min(y, innerHeight - box.height - 4));
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    reportHeight();
  };
  const tooltipTarget = (event: Event) =>
    event.target instanceof Element ? event.target.closest("[data-tooltip]") : null;
  let touched = false;
  document.addEventListener("pointerover", (event) => {
    touched = event.pointerType === "touch";
    const trigger = tooltipTarget(event);
    if (touched || trigger === tooltipTrigger) return;
    hideTooltip();
    if (trigger) tooltipTimer = window.setTimeout(() => showTooltip(trigger), 400);
  });
  document.addEventListener("pointerout", (event) => {
    const trigger = tooltipTarget(event);
    if (!trigger || touched) return;
    if (event.relatedTarget instanceof Node && trigger.contains(event.relatedTarget)) return;
    hideTooltip();
  });
  document.addEventListener("click", (event) => {
    if (!touched) return;
    const trigger = tooltipTarget(event);
    if (trigger && trigger !== tooltipTrigger) {
      hideTooltip();
      showTooltip(trigger);
    } else hideTooltip();
  });
  document.addEventListener("focusin", (event) => {
    // A tap focuses before it clicks. Let the click toggle touch tooltips.
    if (touched) return;
    const trigger = tooltipTarget(event);
    if (trigger && trigger !== tooltipTrigger) {
      hideTooltip();
      showTooltip(trigger);
    }
  });
  document.addEventListener("focusout", hideTooltip);
  document.addEventListener("scroll", hideTooltip, true);
  document.addEventListener("keydown", (event) => {
    touched = false;
    if (event.key === "Escape") hideTooltip();
  });

  // Tabs: `[role="tablist"]` of `[role="tab"]` buttons controlling `[role="tabpanel"]`s.
  const allTabs = (element: Element) => [
    ...(element.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
  ];
  const tabsOf = (element: Element) =>
    allTabs(element).filter(
      (item) => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true",
    );
  const panelOf = (tab: Element) =>
    document.getElementById(tab.getAttribute("aria-controls") ?? "");
  const selectTab = (tab: HTMLElement) => {
    // Several tabs may share one panel, so hide the others before showing it.
    const selectedPanel = panelOf(tab);
    for (const item of allTabs(tab)) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.classList.toggle("active", selected);
      item.tabIndex = selected ? 0 : -1;
      const panel = panelOf(item);
      if (panel && panel !== selectedPanel) panel.hidden = true;
    }
    if (selectedPanel) selectedPanel.hidden = false;
    reportHeight();
  };
  document.addEventListener("click", (event) => {
    const tab =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[role="tab"]') : null;
    if (tab && tabsOf(tab).includes(tab)) selectTab(tab);
  });
  document.addEventListener("keydown", (event) => {
    const tab =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[role="tab"]') : null;
    if (!tab) return;
    const tabs = tabsOf(tab);
    const index = tabs.indexOf(tab);
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? tabs[(index + 1) % tabs.length]
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? tabs[(index - 1 + tabs.length) % tabs.length]
          : event.key === "Home"
            ? tabs[0]
            : event.key === "End"
              ? tabs.at(-1)
              : undefined;
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    next.focus();
  });
  const initTabs = () => {
    for (const list of document.querySelectorAll('[role="tablist"]:not([data-bb-tabs])')) {
      list.setAttribute("data-bb-tabs", "");
      const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
      const active =
        tabs.find(
          (tab) => tab.getAttribute("aria-selected") === "true" || tab.classList.contains("active"),
        ) ?? tabsOf(list.querySelector('[role="tab"]') ?? list)[0];
      if (active) selectTab(active);
    }
  };

  // Variant carousels: `.viz-carousel` with one `[data-variant]` child per design.
  const initCarousels = () => {
    for (const carousel of document.querySelectorAll<HTMLElement>(
      ".viz-carousel:not([data-bb-carousel])",
    )) {
      const variants = [...carousel.children].filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child.hasAttribute("data-variant"),
      );
      if (variants.length === 0) continue;
      carousel.setAttribute("data-bb-carousel", "");
      const nav = document.createElement("div");
      nav.className = "viz-carousel-nav";
      nav.setAttribute("role", "group");
      nav.setAttribute(
        "aria-label",
        `${carousel.getAttribute("aria-label") ?? "Designs"} navigation`,
      );
      const button = (label: string, icon: string) => {
        const element = document.createElement("button");
        element.type = "button";
        element.setAttribute("aria-label", label);
        element.setAttribute("data-tooltip", label);
        element.innerHTML = `<i data-lucide="${icon}"></i>`;
        return element;
      };
      const previous = button(carousel.dataset.previousLabel ?? "Previous design", "chevron-left");
      const next = button(carousel.dataset.nextLabel ?? "Next design", "chevron-right");
      const picker = document.createElement("select");
      picker.setAttribute("aria-label", "Design");
      for (const [index, variant] of variants.entries()) {
        picker.append(new Option(variant.dataset.variant || `Design ${index + 1}`, String(index)));
      }
      const count = document.createElement("output");
      count.setAttribute("aria-live", "polite");
      let current = Math.max(
        0,
        variants.findIndex((variant) => !variant.hidden),
      );
      const show = (index: number) => {
        current = (index + variants.length) % variants.length;
        for (const [position, variant] of variants.entries()) variant.hidden = position !== current;
        picker.value = String(current);
        count.textContent = `${current + 1} / ${variants.length}`;
        reportHeight();
      };
      previous.addEventListener("click", () => show(current - 1));
      next.addEventListener("click", () => show(current + 1));
      picker.addEventListener("change", () => show(Number(picker.value)));
      nav.append(previous, picker, count, next);
      carousel.append(nav);
      show(current);
    }
  };

  const enhance = () => {
    if (tooltipTrigger && !tooltipTrigger.isConnected) hideTooltip();
    initTabs();
    initCarousels();
    void renderIcons();
  };
  // Enhance after parsing. A parser-blocking script mid-fragment must not see
  // half a carousel or tab list. Later DOM changes are reconciled as they land.
  addEventListener("DOMContentLoaded", () => {
    new MutationObserver(enhance).observe(root, { childList: true, subtree: true });
    enhance();
    new ResizeObserver(reportHeight).observe(document.body);
    reportHeight();
  });
  addEventListener("load", reportHeight);
}
