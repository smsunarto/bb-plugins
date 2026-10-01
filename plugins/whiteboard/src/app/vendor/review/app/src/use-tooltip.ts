// Vendored from dev.fast review/app/src/use-tooltip.ts @4ecc570 (MIT).
import type { ReviewTooltipOptions } from "../../../../../shared/vendor/review-protocol/src/index.ts";
import { useCallback } from "react";

import { useOptionalReviewSession } from "./host/review-session.tsx";

/**
 * Attach the host's tooltip to an element, or a native `title` without a
 * Desktop host. `instant` asks for the Whiteboard tooltip with no delay, for
 * small targets; `detail` is its fainter second line.
 */
export function useTooltip<T extends HTMLElement = HTMLButtonElement>(
  text: string,
  { instant, detail }: ReviewTooltipOptions = {},
) {
  const setupTooltip = useOptionalReviewSession()?.bridge.setupTooltip;

  return useCallback(
    (target: T | null) => {
      if (!target) return;

      if (setupTooltip) {
        const tooltip = setupTooltip(target, text, { instant, detail });

        return () => tooltip.dispose();
      }

      target.title = detail ? `${text}\n${detail}` : text;

      return () => target.removeAttribute("title");
    },
    [setupTooltip, text, instant, detail],
  );
}
