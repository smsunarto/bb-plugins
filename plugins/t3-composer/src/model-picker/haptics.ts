/**
 * A selection tick, as a native picker plays when it lands on a new value.
 *
 * BB's mobile app injects `window.bb.native` into its WebView and plays a
 * native haptic for `{ type: "haptic", kind }`, honoring the device's
 * Settings → This device → Haptics switch. The plugin SDK does not wrap the
 * bridge yet; this reads the same global as `plugins/gtd-sidebar/lib/native-haptics.ts`.
 * Mobile browsers outside the app fall back to the Vibration API, which
 * Android honors and iOS Safari ignores: Safari has no haptic a drag can play.
 */
export function selectionHaptic() {
  if (typeof window === "undefined") return;
  const native = (window as { bb?: { native?: { post?: unknown; capabilities?: unknown } } }).bb
    ?.native;
  if (
    typeof native?.post === "function" &&
    Array.isArray(native.capabilities) &&
    native.capabilities.includes("haptic")
  ) {
    (native.post as (message: unknown) => void)({ type: "haptic", kind: "selection" });
    return;
  }
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate(8);
  }
}
