import { useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";

/** Composer action slots clip overflow, so anchor feedback outside that container. */
export function RoutingNotice({
  anchor,
  message,
  error,
}: {
  anchor: RefObject<HTMLElement | null>;
  message: string;
  error: boolean;
}) {
  const notice = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const target = anchor.current;
    const popup = notice.current;
    if (!target || !popup) return;
    const view = target.ownerDocument.defaultView!;
    const position = () => {
      const rect = target.getBoundingClientRect();
      popup.style.left = `${Math.max(8, Math.min(view.innerWidth - popup.offsetWidth - 8, rect.right - popup.offsetWidth))}px`;
      popup.style.top = `${Math.max(8, rect.top - popup.offsetHeight - 8)}px`;
    };
    position();
    const resize = new ResizeObserver(position);
    resize.observe(target);
    resize.observe(popup);
    view.addEventListener("resize", position);
    view.addEventListener("scroll", position, true);
    return () => {
      resize.disconnect();
      view.removeEventListener("resize", position);
      view.removeEventListener("scroll", position, true);
    };
  }, [anchor]);

  return createPortal(
    <span
      ref={notice}
      className={`autorouter-notice ${error ? "autorouter-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {message}
    </span>,
    document.body,
  );
}
