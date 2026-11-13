// BB's model-picker shortcuts (cycle model, provider and effort) are handled inside BB's own
// picker, which this composer replaces with T3's. So T3's pickers handle the same commands
// themselves: they read the effective bindings from `system.config()` and match key events
// with BB's rules (`matchesShortcut` mirrors BB's app keybinding matcher).

import { useEffect, useSyncExternalStore } from "react";
import { useSdk, type PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

type Keybinding = Awaited<
  ReturnType<PluginBrowserBbSdk["system"]["config"]>
>["keybindings"][number];
export type KeyShortcut = Keybinding["shortcut"];

export type ModelShortcutCommand =
  | "modelPicker.cycleModel"
  | "modelPicker.cycleModelBackward"
  | "modelPicker.cycleProvider"
  | "modelPicker.cycleProviderBackward"
  | "modelPicker.cycleReasoning"
  | "modelPicker.cycleReasoningBackward";

const COMMANDS: ReadonlySet<string> = new Set<ModelShortcutCommand>([
  "modelPicker.cycleModel",
  "modelPicker.cycleModelBackward",
  "modelPicker.cycleProvider",
  "modelPicker.cycleProviderBackward",
  "modelPicker.cycleReasoning",
  "modelPicker.cycleReasoningBackward",
]);

export interface ModelShortcutBinding {
  command: ModelShortcutCommand;
  shortcut: KeyShortcut;
}

export type Platform = "mac" | "windows" | "linux";

export function currentPlatform(): Platform {
  const name = typeof navigator === "undefined" ? "" : navigator.platform;
  if (/Mac|iPhone|iPad|iPod/u.test(name)) return "mac";
  return /Win/u.test(name) ? "windows" : "linux";
}

/**
 * The bindings for the model-picker cycle commands that apply while the picker is closed on
 * this platform. BB lists each command once per platform when its shortcut differs by platform.
 */
export function modelShortcutBindings(
  keybindings: readonly Keybinding[],
  platform: Platform,
): ModelShortcutBinding[] {
  return keybindings.flatMap((binding) => {
    if (!COMMANDS.has(binding.command) || binding.desktopOnly) return [];
    const { all, none } = binding.when;
    if (all.includes("modelPickerOpen")) return [];
    for (const candidate of ["mac", "windows", "linux"] as const) {
      const condition = `${candidate}Platform` as const;
      if (all.includes(condition) && candidate !== platform) return [];
      if (none.includes(condition) && candidate === platform) return [];
    }
    return [{ command: binding.command as ModelShortcutCommand, shortcut: binding.shortcut }];
  });
}

// BB's normalization of a key event: Shift+symbol names the unshifted key, and with Alt held a
// letter or digit is read from its physical key, as macOS turns Option+M into "µ".
const SHIFTED: Readonly<Record<string, string>> = {
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

type KeyEventLike = Pick<
  KeyboardEvent,
  "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
>;

function keyName(event: KeyEventLike) {
  if (event.key === " " || event.key === "Spacebar") return "Space";
  if (event.altKey && !/^[a-z0-9]$/iu.test(event.key)) {
    if (/^Key[A-Z]$/u.test(event.code)) return event.code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/u.test(event.code)) return event.code.slice(5);
  }
  return event.shiftKey ? (SHIFTED[event.key] ?? event.key) : event.key;
}

export function matchesShortcut(event: KeyEventLike, shortcut: KeyShortcut, isMac: boolean) {
  const meta = shortcut.meta || (shortcut.mod && isMac);
  const control = shortcut.control || (shortcut.mod && !isMac);
  return (
    keyName(event).toLowerCase() === shortcut.key.toLowerCase() &&
    event.metaKey === meta &&
    event.ctrlKey === control &&
    event.altKey === shortcut.alt &&
    event.shiftKey === shortcut.shift
  );
}

export function matchModelShortcut(
  event: KeyEventLike,
  bindings: readonly ModelShortcutBinding[],
  platform: Platform,
): ModelShortcutCommand | null {
  const isMac = platform === "mac";
  return (
    bindings.find((binding) => matchesShortcut(event, binding.shortcut, isMac))?.command ?? null
  );
}

/** The value after `current`, wrapping; null when there is nothing else to move to. */
export function cycleValue<T>(values: readonly T[], current: T | undefined, backward: boolean) {
  if (values.length === 0) return null;
  const ordered = backward ? [...values].reverse() : values;
  const next = ordered[(ordered.indexOf(current as T) + 1) % ordered.length];
  return next === undefined || next === current ? null : next;
}

// One read per page, shared by every composer, refreshed when the page comes back into view so
// a shortcut changed in Settings applies without a reload.
const REFRESH_AFTER_MS = 60_000;
const DEADLINE_MS = 10_000;
let keybindings: readonly Keybinding[] = [];
let fetchedAt = 0;
let inFlight = false;
const listeners = new Set<() => void>();

function refresh(sdk: PluginBrowserBbSdk) {
  if (inFlight || Date.now() - fetchedAt < REFRESH_AFTER_MS) return;
  inFlight = true;
  Promise.resolve()
    .then(() => sdk.system.config({ signal: AbortSignal.timeout(DEADLINE_MS) }))
    .then((config) => {
      keybindings = config.keybindings;
      fetchedAt = Date.now();
      return listeners.forEach((listener) => listener());
    })
    // Keep the last bindings; the next visibility change tries again.
    .catch(() => undefined)
    .finally(() => {
      inFlight = false;
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** BB's effective keybindings; empty until the first read lands. */
export function useKeybindings(enabled: boolean): readonly Keybinding[] {
  const sdk = useSdk();
  useEffect(() => {
    if (!enabled) return;
    refresh(sdk);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh(sdk);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [sdk, enabled]);
  return useSyncExternalStore(subscribe, () => keybindings);
}
