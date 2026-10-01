/**
 * BB's mobile app injects `window.bb.native` into its WebView and plays a
 * native haptic for `{ type: "haptic", kind }`, honoring the device's
 * Settings → This device → Haptics switch. The plugin SDK does not wrap the
 * bridge yet, so this reads the same global BB's web app reads
 * (`apps/app/src/lib/native-shell`). Unlike the `<input switch>` trick in
 * `ios-haptics.ts`, it needs no tap, so it can fire when a long press lands.
 *
 * Returns false outside the mobile app, where the caller may fall back.
 */
export type NativeHapticKind =
  | "selection"
  | "impact-light"
  | "impact-medium"
  | "impact-heavy"
  | "success"
  | "warning"
  | "error";

interface NativeBridge {
  post?: unknown;
  capabilities?: unknown;
}

export function nativeHaptic(kind: NativeHapticKind): boolean {
  if (typeof window === "undefined") return false;
  const native = (window as { bb?: { native?: NativeBridge } }).bb?.native;
  if (typeof native?.post !== "function") return false;
  if (!Array.isArray(native.capabilities) || !native.capabilities.includes("haptic")) return false;
  (native.post as (message: unknown) => void)({ type: "haptic", kind });
  return true;
}
