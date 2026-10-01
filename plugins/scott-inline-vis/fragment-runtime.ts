import { FRAGMENT_STYLES } from "./fragment-styles.ts";
import {
  parseTweakGroups,
  TWEAK_LIMITS,
  type TweakControl,
  type TweakGroup,
  type TweakValue,
} from "./tweak-contract.ts";

export {
  TWEAK_LIMITS,
  type TweakControl,
  type TweakGroup,
  type TweakValue,
} from "./tweak-contract.ts";

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
  tweak: "bb:inline-vis:tweak",
  tweakChange: "bb:inline-vis:tweak-change",
  tweakReset: "bb:inline-vis:tweak-reset",
  tweakOriginal: "bb:inline-vis:tweak-original",
  escape: "bb:inline-vis:escape",
} as const;

export const MAX_WIDGET_STATE_BYTES = 16 * 1024;
export const LUCIDE_URL = "https://unpkg.com/lucide@1.49.0/dist/umd/lucide.min.js";

export type FrameMessage =
  | { type: "resize"; height: number }
  | { type: "state"; state: string; modelContent?: string | null }
  | {
      type: "tweak";
      groups: TweakGroup[];
      original: boolean;
      changed: boolean;
      reset?: string | null;
    }
  | { type: "escape" }
  | { type: "followUp"; prompt: string };

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function boundedJson(value: unknown): value is string {
  return (
    typeof value === "string" && new Blob([value]).size <= MAX_WIDGET_STATE_BYTES && isJson(value)
  );
}

function parseStateMessage(
  message: Record<string, unknown>,
): Extract<FrameMessage, { type: "state" }> | null {
  if (!boundedJson(message.state)) return null;
  if (message.modelContent === undefined) return { type: "state", state: message.state };
  if (message.modelContent === null)
    return { type: "state", state: message.state, modelContent: null };
  return boundedJson(message.modelContent)
    ? { type: "state", state: message.state, modelContent: message.modelContent }
    : null;
}

function parseTweakMessage(
  message: Record<string, unknown>,
): Extract<FrameMessage, { type: "tweak" }> | null {
  const groups = parseTweakGroups(message.groups);
  if (!groups || typeof message.original !== "boolean" || typeof message.changed !== "boolean")
    return null;
  const reset = message.reset;
  if (
    reset !== undefined &&
    reset !== null &&
    !(typeof reset === "string" && reset.length > 0 && reset.length <= TWEAK_LIMITS.label)
  )
    return null;
  if (reset !== undefined && !message.changed) return null;
  return {
    type: "tweak",
    groups,
    original: message.original,
    changed: message.changed,
    ...(reset !== undefined ? { reset } : {}),
  };
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
      return parseStateMessage(message);
    case FRAGMENT_MESSAGES.tweak:
      return parseTweakMessage(message);
    case FRAGMENT_MESSAGES.escape:
      return { type: "escape" };
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
  /** JSON array of saved Tweak changes, addressed by stable registration IDs. */
  tweaks?: string | null;
  messages: typeof FRAGMENT_MESSAGES;
  lucideUrl: string;
  maxStateBytes: number;
  tweakLimits: typeof TWEAK_LIMITS;
}

/** Add the stylesheet and runtime to a parsed fragment document's head. */
export function injectFragmentRuntime(
  document: Document,
  config: Omit<RuntimeConfig, "messages" | "lucideUrl" | "maxStateBytes" | "tweakLimits">,
): void {
  const style = document.createElement("style");
  style.textContent = FRAGMENT_STYLES;
  const script = document.createElement("script");
  const json = JSON.stringify({
    ...config,
    messages: FRAGMENT_MESSAGES,
    lucideUrl: LUCIDE_URL,
    maxStateBytes: MAX_WIDGET_STATE_BYTES,
    tweakLimits: TWEAK_LIMITS,
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
  let original = false;
  let originalRenderDepth = 0;
  try {
    state = config.state === null ? null : JSON.parse(config.state);
  } catch {
    // A malformed stored snapshot must not keep the fragment from loading.
  }
  const bb = {
    get widgetState() {
      return state;
    },
    async setWidgetState(next: unknown, options?: { modelContent?: unknown }) {
      // Original is a temporary rendering pass. onChange callbacks may save as
      // they draw, but those defaults must not replace the user's saved edits.
      if (originalRenderDepth) return;
      const text = JSON.stringify(next ?? null);
      if (typeof text !== "string") throw new Error("Widget state must be JSON serializable.");
      if (new Blob([text]).size > config.maxStateBytes) {
        throw new Error(`Widget state exceeds ${config.maxStateBytes} bytes.`);
      }
      const payload: Record<string, unknown> = { state: text };
      if (options && Object.prototype.hasOwnProperty.call(options, "modelContent")) {
        if (options.modelContent === null) payload.modelContent = null;
        else {
          const content = JSON.stringify(options.modelContent);
          if (typeof content !== "string")
            throw new Error("Model content must be JSON serializable.");
          if (new Blob([content]).size > config.maxStateBytes)
            throw new Error(`Model content exceeds ${config.maxStateBytes} bytes.`);
          payload.modelContent = content;
        }
      }
      state = JSON.parse(text);
      post(config.messages.state, payload);
    },
    async sendFollowUp(prompt: string) {
      if (typeof prompt !== "string" || !prompt.trim()) {
        throw new Error("sendFollowUp needs a non-empty prompt.");
      }
      post(config.messages.followUp, { prompt });
    },
  };
  // Configurable globals permit ordinary author aliases (`const bb = window.bb`)
  // and helper declarations. The authenticated bridge stays inside this closure.
  Object.defineProperty(window, "bb", { value: Object.freeze(bb), configurable: true });

  // Host-managed Tweak controls. The frame alone owns bound objects and callbacks.
  type BoundControl = {
    descriptor: TweakControl;
    object: Record<string, unknown>;
    property: string;
  };
  type BoundGroup = {
    id: string;
    container: HTMLElement;
    onChange: () => void;
    controls: BoundControl[];
  };
  const tweakGroups = new Map<string, BoundGroup>();
  let tweakReady = false;
  let pendingTweaks = false;
  let changedTweaks = false;
  let lastTweaks = "";
  type SavedControl = { groupId: string; controlId: string; value: unknown };
  const savedTweaks = new Map<string, SavedControl>();
  const initialTweaks = new Map<string, TweakValue>();
  const authoredTweaks = new Map<string, TweakValue>();
  const assignedValues = new WeakMap<Record<string, unknown>, Map<string, TweakValue>>();
  const notifiedValues = new Map<string, TweakValue>();
  const tweakKey = (groupId: string, controlId: string) => JSON.stringify([groupId, controlId]);
  const saveTweak = (groupId: string, controlId: string, value: unknown) =>
    savedTweaks.set(tweakKey(groupId, controlId), { groupId, controlId, value });
  const assign = (control: BoundControl, value: TweakValue) => {
    let properties = assignedValues.get(control.object);
    if (!properties) {
      properties = new Map();
      assignedValues.set(control.object, properties);
    }
    properties.set(control.property, value);
    control.object[control.property] = value;
  };
  try {
    const controls: unknown = JSON.parse(config.tweaks ?? "[]");
    if (Array.isArray(controls)) {
      for (const entry of controls) {
        if (typeof entry?.groupId === "string" && typeof entry?.controlId === "string")
          saveTweak(entry.groupId, entry.controlId, entry.value);
      }
    }
  } catch {
    /* Ignore malformed persisted controls. */
  }
  const label = (value: unknown, fallback: string) =>
    (typeof value === "string" ? value.trim() : "").slice(0, config.tweakLimits.label) || fallback;
  const stableId = (value: string) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++)
      hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return value.length <= 140 ? value : `${value.slice(0, 120)}-${(hash >>> 0).toString(36)}`;
  };
  const visible = (container: HTMLElement) => {
    for (let element: HTMLElement | null = container; element; element = element.parentElement) {
      if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  };
  const reportTweaks = (changed: boolean, reset?: string | null) => {
    const groups: TweakGroup[] = [...tweakGroups.values()]
      .filter((group) => group.container.isConnected)
      .map((group) => ({
        id: group.id,
        title: label(group.container.getAttribute("aria-label"), "Adjustments"),
        variant:
          group.container
            .closest<HTMLElement>("[data-variant]")
            ?.dataset.variant?.slice(0, config.tweakLimits.label) || null,
        visible: visible(group.container),
        controls: group.controls.map((control) => control.descriptor),
      }));
    const snapshot = JSON.stringify({ groups, original });
    if (snapshot === lastTweaks && reset === undefined) return;
    lastTweaks = snapshot;
    post(config.messages.tweak, {
      groups,
      original,
      changed,
      ...(reset !== undefined ? { reset } : {}),
    });
  };
  const publishTweaks = (changed = false) => {
    changedTweaks ||= changed;
    if (!tweakReady || pendingTweaks) return;
    pendingTweaks = true;
    queueMicrotask(() => {
      pendingTweaks = false;
      const changed = changedTweaks;
      changedTweaks = false;
      reportTweaks(changed);
    });
  };
  const validValue = (control: TweakControl, value: unknown): value is TweakValue => {
    switch (control.type) {
      case "slider":
        return (
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= control.min &&
          value <= control.max
        );
      case "color":
        return typeof value === "string" && /^#[\da-f]{6}$/iu.test(value);
      case "toggle":
        return typeof value === "boolean";
      case "select":
        return (
          typeof value === "string" && control.options.some((option) => option.value === value)
        );
    }
  };
  const validReference = (value: unknown) =>
    value === undefined ||
    (typeof value === "string" && value.length > 0 && value.length <= config.tweakLimits.label);
  const notifyingGroups = new Set<string>();
  const markNotified = (group: BoundGroup) => {
    for (const control of group.controls)
      notifiedValues.set(tweakKey(group.id, control.descriptor.id), control.descriptor.value);
  };
  const needsNotification = (group: BoundGroup) =>
    group.controls.some(
      (control) =>
        notifiedValues.get(tweakKey(group.id, control.descriptor.id)) !== control.descriptor.value,
    );
  const markSharedRender = (group: BoundGroup) => {
    for (const current of tweakGroups.values()) {
      if (current.onChange === group.onChange) markNotified(current);
    }
  };
  const notify = (group: BoundGroup) => {
    if (notifyingGroups.has(group.id)) return;
    // A shared render consumes all of its groups. Remember values before it can
    // rebuild them, including when the render itself is deferred to another task.
    markSharedRender(group);
    notifyingGroups.add(group.id);
    const temporary = original;
    if (temporary) originalRenderDepth++;
    try {
      group.onChange();
    } catch (error) {
      console.error("inline-vis: Tweak onChange failed", error);
    } finally {
      markSharedRender(group);
      if (temporary) originalRenderDepth--;
      notifyingGroups.delete(group.id);
    }
  };
  const pendingRestores = new Map<string, BoundGroup>();
  let pendingRestoreFlush = false;
  const notifyGroups = (groups: BoundGroup[]) => {
    for (const group of groups) markNotified(group);
    const callbacks = new Set<() => void>();
    for (const group of groups) {
      const current = tweakGroups.get(group.id);
      if (!current || callbacks.has(current.onChange)) continue;
      callbacks.add(current.onChange);
      notify(current);
    }
  };
  const flushRestores = () => {
    pendingRestoreFlush = false;
    if (!tweakReady) return;
    const groups = [...pendingRestores.values()].filter(
      (group) => tweakGroups.get(group.id) === group && needsNotification(group),
    );
    pendingRestores.clear();
    // Mark the whole batch before invoking callbacks. One callback may replace
    // another group that has the same render function.
    notifyGroups(groups);
  };
  const notifyRestored = (group: BoundGroup) => {
    // onChange may replace its own container and register fresh bound objects.
    // Restoring those objects is part of this render, not another notification.
    if (notifyingGroups.has(group.id) || !needsNotification(group)) return;
    pendingRestores.set(group.id, group);
    if (!tweakReady || pendingRestoreFlush) return;
    pendingRestoreFlush = true;
    // Register all controls in the current script before invoking the callback.
    queueMicrotask(flushRestores);
  };
  const bindControl = (group: BoundGroup, control: BoundControl) => {
    const { descriptor, object, property } = control;
    const key = tweakKey(group.id, descriptor.id);
    const initial = initialTweaks.get(key);
    if (initial === undefined) initialTweaks.set(key, descriptor.initialValue);
    // A dependent select or range may temporarily exclude its first default.
    // Keep it for when it becomes valid again and use the current valid default.
    else if (validValue(descriptor, initial)) descriptor.initialValue = initial as never;
    const authored = descriptor.value;
    const previousAuthored = authoredTweaks.get(key);
    const previousAssigned = assignedValues.get(object)?.get(property);
    const authorChanged =
      !original &&
      previousAuthored !== undefined &&
      authored !== (previousAssigned ?? previousAuthored);
    if (!original) {
      const nextAuthored =
        previousAssigned === undefined || authorChanged ? authored : (previousAuthored ?? authored);
      authoredTweaks.set(key, nextAuthored);
    }
    const saved = savedTweaks.get(key);
    const restored =
      !authorChanged && saved && validValue(descriptor, saved.value) && saved.value !== authored;
    if (restored) descriptor.value = saved.value as never;
    saveTweak(group.id, descriptor.id, descriptor.value);
    group.controls.push(control);
    assign(control, original ? descriptor.initialValue : descriptor.value);
    if (restored) notifyRestored(group);
    publishTweaks(authorChanged && saved?.value !== descriptor.value);
  };
  class Tweak {
    private readonly group: BoundGroup;
    constructor(options: { container: HTMLElement; onChange: () => void }) {
      if (!(options?.container instanceof HTMLElement) || typeof options.onChange !== "function") {
        throw new Error("Tweak needs an HTMLElement container and an onChange callback.");
      }
      if (!options.container.isConnected && !options.container.id) {
        throw new Error("A detached Tweak container needs a stable id before registration.");
      }
      const name =
        options.container.id ||
        `${options.container.closest<HTMLElement>("[data-variant]")?.dataset.variant || "global"}:${label(options.container.getAttribute("aria-label"), "Adjustments")}`;
      const baseId = `tweak-${stableId(name)}`;
      let id = baseId;
      let occurrence = 2;
      while (tweakGroups.has(id)) {
        const previous = tweakGroups.get(id)!.container;
        const preparedReplacement =
          options.container.id &&
          previous !== options.container &&
          !options.container.isConnected &&
          previous.id === options.container.id;
        if (previous === options.container || !previous.isConnected || preparedReplacement) {
          // A prepared or mounted replacement keeps the semantic identity so
          // saved settings survive re-rendering and the next page load.
          tweakGroups.delete(id);
          pendingRestores.delete(id);
          break;
        }
        id = `${baseId}:${occurrence++}`;
      }
      if (tweakGroups.size >= config.tweakLimits.groups) throw new Error("Too many Tweak groups.");
      this.group = { id, container: options.container, onChange: options.onChange, controls: [] };
      tweakGroups.set(this.group.id, this.group);
      publishTweaks();
    }
    private add(
      object: Record<string, unknown>,
      property: string,
      description: Record<string, unknown>,
    ) {
      if (tweakGroups.get(this.group.id) !== this.group)
        throw new Error(
          "This Tweak group was disposed or replaced. Register one Tweak group per container.",
        );
      if (this.group.controls.length >= config.tweakLimits.controls)
        throw new Error("Too many Tweak controls.");
      if (
        typeof object !== "object" ||
        object === null ||
        typeof property !== "string" ||
        !Object.prototype.hasOwnProperty.call(object, property)
      ) {
        throw new Error("Tweak needs a bound object property.");
      }
      if (this.group.controls.some((control) => control.property === property))
        throw new Error("A Tweak property can only be registered once per group.");
      const descriptor = {
        ...description,
        id: stableId(`${description.type}:${property}`),
        value: object[property],
        initialValue: object[property],
        label: label(description.label, property),
      } as TweakControl;
      if (!validValue(descriptor, descriptor.value) || !validReference(descriptor.reference)) {
        throw new Error("Invalid Tweak value or reference.");
      }
      bindControl(this.group, { descriptor, object, property });
      return this;
    }
    addSlider(
      object: Record<string, unknown>,
      property: string,
      options: {
        label?: string;
        min: number;
        max: number;
        step?: number;
        unit?: string;
        reference?: string;
      },
    ) {
      const step = options?.step ?? 1;
      if (
        !options ||
        !Number.isFinite(options.min) ||
        !Number.isFinite(options.max) ||
        options.max <= options.min ||
        !Number.isFinite(step) ||
        step <= 0
      )
        throw new Error("Invalid Tweak slider range.");
      return this.add(object, property, {
        type: "slider",
        label: options.label,
        min: options.min,
        max: options.max,
        step,
        ...(options.unit !== undefined
          ? { unit: String(options.unit).slice(0, config.tweakLimits.label) }
          : {}),
        ...(options.reference !== undefined ? { reference: options.reference } : {}),
      });
    }
    addColorPicker(
      object: Record<string, unknown>,
      property: string,
      options: { label?: string; reference?: string } = {},
    ) {
      return this.add(object, property, {
        type: "color",
        label: options.label,
        ...(options.reference !== undefined ? { reference: options.reference } : {}),
      });
    }
    addToggle(
      object: Record<string, unknown>,
      property: string,
      options: { label?: string; reference?: string } = {},
    ) {
      return this.add(object, property, {
        type: "toggle",
        label: options.label,
        ...(options.reference !== undefined ? { reference: options.reference } : {}),
      });
    }
    addSelect(
      object: Record<string, unknown>,
      property: string,
      options: {
        label?: string;
        options: (string | { label: string; value: string })[];
        reference?: string;
      },
    ) {
      if (
        !Array.isArray(options?.options) ||
        options.options.length === 0 ||
        options.options.length > config.tweakLimits.options
      )
        throw new Error("Invalid Tweak select options.");
      const choices = options.options.map((option) =>
        typeof option === "string"
          ? { label: option, value: option }
          : { label: option?.label, value: option?.value },
      );
      if (
        choices.some(
          (choice) =>
            typeof choice.label !== "string" ||
            !choice.label ||
            choice.label.length > config.tweakLimits.label ||
            typeof choice.value !== "string" ||
            !choice.value ||
            choice.value.length > config.tweakLimits.value,
        ) ||
        new Set(choices.map((choice) => choice.value)).size !== choices.length
      )
        throw new Error("Invalid Tweak select options.");
      return this.add(object, property, {
        type: "select",
        label: options.label,
        options: choices,
        ...(options.reference !== undefined ? { reference: options.reference } : {}),
      });
    }
    dispose() {
      if (tweakGroups.get(this.group.id) !== this.group) return;
      tweakGroups.delete(this.group.id);
      pendingRestores.delete(this.group.id);
      publishTweaks();
    }
  }
  Object.defineProperty(window, "Tweak", { value: Tweak, configurable: true });
  const changeTweak = (data: Record<string, unknown>) => {
    if (original || typeof data.groupId !== "string" || typeof data.controlId !== "string") return;
    const group = tweakGroups.get(data.groupId);
    const control = group?.controls.find((item) => item.descriptor.id === data.controlId);
    if (
      !group ||
      !group.container.isConnected ||
      !control ||
      !validValue(control.descriptor, data.value) ||
      control.descriptor.value === data.value
    )
      return;
    control.descriptor.value = data.value as never;
    saveTweak(group.id, control.descriptor.id, data.value);
    assign(control, data.value);
    notify(group);
    publishTweaks(true);
  };
  const resetTweaks = (groupId: unknown) => {
    if (
      groupId !== undefined &&
      !(
        typeof groupId === "string" &&
        groupId.length > 0 &&
        groupId.length <= config.tweakLimits.label
      )
    )
      return;
    for (const [key, saved] of savedTweaks) {
      if (groupId === undefined || saved.groupId === groupId) savedTweaks.delete(key);
    }
    // onChange can replace entries, so iterate the groups present at Reset.
    const groups = [...tweakGroups.values()];
    const changedGroups: BoundGroup[] = [];
    for (const group of groups) {
      if (groupId !== undefined && groupId !== group.id) continue;
      let changed = false;
      for (const control of group.controls) {
        changed ||= control.descriptor.value !== control.descriptor.initialValue;
        control.descriptor.value = control.descriptor.initialValue as never;
        saveTweak(group.id, control.descriptor.id, control.descriptor.initialValue);
        assign(control, control.descriptor.initialValue);
      }
      if (changed) changedGroups.push(group);
    }
    notifyGroups(changedGroups);
    // Reset is explicit intent, including controls that have not registered yet.
    // Publish it separately so multiple scoped resets keep their exact scopes.
    changedTweaks = false;
    reportTweaks(true, groupId === undefined ? null : (groupId as string));
  };
  const previewOriginal = (active: unknown) => {
    if (typeof active !== "boolean" || original === active) return;
    original = active;
    // A replacement registered by onChange belongs to this rendering pass.
    const groups = [...tweakGroups.values()];
    const changedGroups: BoundGroup[] = [];
    for (const group of groups) {
      let changed = false;
      for (const control of group.controls) {
        const value = original ? control.descriptor.initialValue : control.descriptor.value;
        changed ||= control.object[control.property] !== value;
        assign(control, value);
      }
      if (changed || !original) changedGroups.push(group);
    }
    notifyGroups(changedGroups);
    publishTweaks();
  };
  addEventListener("message", (event) => {
    const data = event.data as Record<string, unknown> | null;
    if (event.source !== parent || data?.token !== config.token) return;
    if (data.type === config.messages.tweakChange) changeTweak(data);
    else if (data.type === config.messages.tweakReset) resetTweaks(data.groupId);
    else if (data.type === config.messages.tweakOriginal) previewOriginal(data.active);
  });

  // Let author handlers consume Escape first. The next task sees the final
  // defaultPrevented value even when handlers run after this window listener.
  const hasNativeOverlay = () => {
    for (const selector of [
      "dialog:modal",
      'dialog[open][closedby="closerequest" i]',
      'dialog[open][closedby="any" i]',
    ]) {
      try {
        if (document.querySelector(selector)) return true;
      } catch {
        /* A browser without this native feature cannot have it open. */
      }
    }
    try {
      // Manual popovers are persistent HUDs. Escape does not dismiss them.
      if (
        [...document.querySelectorAll<HTMLElement>(":popover-open")].some(
          (element) => element.popover !== "manual",
        )
      )
        return true;
    } catch {
      /* Popovers are unavailable in this browser. */
    }
    return false;
  };
  addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || hasNativeOverlay()) return;
    setTimeout(() => {
      if (!event.defaultPrevented) post(config.messages.escape, {});
    }, 0);
  });

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
    if (event.key === "Escape") {
      if (tooltip?.isConnected) event.preventDefault();
      hideTooltip();
    }
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
    publishTweaks();
  };
  // Enhance after parsing. A parser-blocking script mid-fragment must not see
  // half a carousel or tab list. Later DOM changes are reconciled as they land.
  addEventListener("DOMContentLoaded", () => {
    new MutationObserver(enhance).observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "style", "class", "aria-hidden", "aria-label", "data-variant"],
    });
    enhance();
    new ResizeObserver(reportHeight).observe(document.body);
    reportHeight();
  });
  addEventListener("load", () => {
    reportHeight();
    // Wait until authors' DOMContentLoaded and load handlers finish registering
    // controls. Initial snapshots must not replace saved state with half a page.
    setTimeout(() => {
      tweakReady = true;
      flushRestores();
      publishTweaks();
    }, 0);
  });
}
