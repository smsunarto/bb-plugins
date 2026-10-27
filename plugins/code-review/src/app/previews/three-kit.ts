import { THREE_KIT_PATH } from "../../shared/blob-url.ts";

/** three.js and its loaders, as `vendor/three-kit-entry.ts` exports them. */
export type ThreeKit = typeof import("../../../vendor/three-kit-entry.ts");

let loading: { url: string; kit: Promise<ThreeKit> } | null = null;

/**
 * The kit, imported from the plugin's own route the first time a preview
 * needs it. Plugin bundles have no code splitting, so this keeps three.js out
 * of every Review visit that shows no model or game image.
 */
export function loadThreeKit(pluginId: string): Promise<ThreeKit> {
  const url = `/api/v1/plugins/${encodeURIComponent(pluginId)}/http${THREE_KIT_PATH}`;
  if (loading?.url !== url) {
    const kit = import(/* @vite-ignore */ url) as Promise<ThreeKit>;
    loading = { url, kit };
    // A failed import is asked again next time, not remembered.
    kit.catch(() => {
      if (loading?.kit === kit) loading = null;
    });
  }
  return loading.kit;
}
