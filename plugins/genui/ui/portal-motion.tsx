import type { ComponentType } from "react";
import { PortalScopeExtraProvider } from "../lib/portal-scope";
import { useMotionScope } from "./components/motion";

/**
 * Wraps a slot component so overlays it portals (dialogs, popovers, menus) carry
 * `data-genui-motion` too: app.css stops their animations when the Animations setting is off.
 */
export function withPortalMotion<P extends object>(Component: ComponentType<P>): ComponentType<P> {
  function WithPortalMotion(props: P) {
    const motion = useMotionScope();
    return (
      <PortalScopeExtraProvider value={motion}>
        <Component {...props} />
      </PortalScopeExtraProvider>
    );
  }
  WithPortalMotion.displayName = `WithPortalMotion(${Component.displayName ?? Component.name})`;
  return WithPortalMotion;
}
