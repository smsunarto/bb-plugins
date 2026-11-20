import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

/**
 * A light haptic tick when the right panel's active tab changes on a phone:
 * a tap on a tab or pinned view, a swipe across the tab strip, a new tab, or
 * closing the active tab. bb marks the active tab's button `aria-pressed="true"`
 * and flips the attribute in place as the selection moves, so a change of that
 * attribute on a tab button is the switch. One tick per batch of mutations,
 * since one switch flips two buttons.
 *
 * The tick goes through BB's mobile app bridge, the same one gtd-sidebar's
 * phone drawer uses (`plugins/gtd-sidebar/lib/native-haptics.ts`); the app
 * honours the device's Haptics setting. Outside the app there is no bridge
 * and nothing plays.
 */
const TAB_BUTTON = '[data-testid="mobile-panel-tab-pager"] [data-tab-pill] > button[aria-pressed]';

interface NativeBridge {
  post?: unknown;
  capabilities?: unknown;
}

export function nativeSelectionHaptic(view: Window): void {
  const native = (view as { bb?: { native?: NativeBridge } }).bb?.native;
  if (typeof native?.post !== "function") return;
  if (!Array.isArray(native.capabilities) || !native.capabilities.includes("haptic")) return;
  (native.post as (message: unknown) => void)({ type: "haptic", kind: "selection" });
}

export function mountPanelTabHaptics({
  signal,
  document: doc = document,
  haptic,
}: Pick<PluginContentScriptContext, "signal"> & { document?: Document; haptic?: () => void }) {
  const view = doc.defaultView;
  if (signal.aborted || view === null) return () => {};
  const tick = haptic ?? (() => nativeSelectionHaptic(view));

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const { target } = record;
      if (
        target instanceof Element &&
        record.oldValue !== target.getAttribute("aria-pressed") &&
        target.matches(TAB_BUTTON)
      ) {
        tick();
        return;
      }
    }
  });
  observer.observe(doc.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-pressed"],
    attributeOldValue: true,
  });

  const dispose = () => observer.disconnect();
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
