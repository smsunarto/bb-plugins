import { useComposerView } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef } from "react";

/**
 * Plays a light native haptic when a composer starts sending, the way a
 * message app answers the send tap. Mounted as a bare composer banner that
 * renders nothing, so it sees the composer's `isSubmitting` without drawing.
 *
 * The haptic goes through `window.bb.native`, the bridge BB's mobile app
 * injects into its WebView. The plugin SDK does not wrap it yet; BB's web app
 * reads the same global (`apps/app/src/lib/native-shell`). Outside the mobile
 * app there is no bridge and nothing happens. The device's Settings → This
 * device → Haptics switch still applies.
 */
export function SendHaptic() {
  useSendHaptic(useComposerView().run.isSubmitting);
  return null;
}

export function useSendHaptic(isSubmitting: boolean) {
  const wasSubmitting = useRef(isSubmitting);
  useEffect(() => {
    if (isSubmitting && !wasSubmitting.current) nativeHaptic("impact-light");
    wasSubmitting.current = isSubmitting;
  }, [isSubmitting]);
}

/** Same bridge read as `plugins/gtd-sidebar/lib/native-haptics.ts`. */
function nativeHaptic(kind: "impact-light") {
  if (typeof window === "undefined") return;
  const native = (window as { bb?: { native?: { post?: unknown; capabilities?: unknown } } }).bb
    ?.native;
  if (typeof native?.post !== "function") return;
  if (!Array.isArray(native.capabilities) || !native.capabilities.includes("haptic")) return;
  (native.post as (message: unknown) => void)({ type: "haptic", kind });
}
