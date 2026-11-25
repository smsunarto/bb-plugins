import { createContext, useContext } from "react";

declare const __BB_PLUGIN_ID__: string | undefined;

type PortalScopeExtra = Readonly<Partial<Record<`data-${string}`, string>>>;

const NO_EXTRA: PortalScopeExtra = {};
const PortalScopeExtraContext = createContext<PortalScopeExtra>(NO_EXTRA);

/**
 * Adds a plugin's own data attributes to every overlay portaled below it, such as genui's
 * `data-genui-motion`, which its stylesheet reads to stop animations. Portals leave the
 * plugin's mount, so an attribute on an ancestor would not reach them.
 */
export const PortalScopeExtraProvider = PortalScopeExtraContext.Provider;

export function usePortalScopeProps(): {
  "data-bb-portaled-overlay": "";
  "data-bb-plugin-root"?: "";
  "data-bb-plugin"?: string;
  [attribute: `data-${string}`]: string | undefined;
} {
  const extra = useContext(PortalScopeExtraContext);
  const pluginId = typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : undefined;
  return {
    ...extra,
    "data-bb-portaled-overlay": "",
    "data-bb-plugin-root": "",
    ...(pluginId !== undefined
      ? { "data-bb-plugin": pluginId, [`data-bb-plugin-scope-${pluginId}`]: "" }
      : {}),
  };
}
