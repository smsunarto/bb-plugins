import { useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

function SlotOutlet({ element, focus }) {
  const holder = useRef(/** @type {HTMLDivElement | null} */ (null));
  useLayoutEffect(() => {
    const container = holder.current;
    if (!container) return;
    container.append(element);
    const frame = requestAnimationFrame(() => {
      if (focus.current?.isConnected) focus.current.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (element.parentNode === container) element.remove();
    };
  }, [element, focus]);
  return <div ref={holder} data-native-slot-outlet="" className="h-full w-full min-h-0 min-w-0" />;
}

/** Keep plugin React state alive while native BB moves between an inline panel and a portal. */
export function useNativeSlot(children, width, placement) {
  const element = useMemo(() => {
    const node = document.createElement("div");
    node.className = "sb-native-slot";
    node.dataset.storybookComponent = "";
    return node;
  }, []);
  const focus = useRef(null);
  useLayoutEffect(() => {
    element.style.setProperty(
      "--sb-native-width",
      { narrow: "360px", medium: "640px" }[width] ?? "1100px",
    );
    element.dataset.nativeSlotPlacement = placement;
  }, [element, width, placement]);
  useLayoutEffect(() => {
    const trackFocus = (event) => {
      if (element.contains(event.target)) focus.current = event.target;
      else if (element.isConnected) focus.current = null;
    };
    document.addEventListener("focusin", trackFocus);
    return () => document.removeEventListener("focusin", trackFocus);
  }, [element]);
  return {
    outlet: <SlotOutlet element={element} focus={focus} />,
    portal: createPortal(children, element),
  };
}
