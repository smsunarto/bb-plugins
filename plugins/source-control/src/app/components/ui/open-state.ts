import { createContext, useCallback, useContext, useMemo, useState } from "react";

/** A Radix root's open state, controlled or not, shared with its content. */
export type OpenProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function useOpenState({ open, defaultOpen = false, onOpenChange }: OpenProps) {
  const [own, setOwn] = useState(defaultOpen);
  const value = open ?? own;
  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setOwn(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange],
  );
  return [value, setOpen] as const;
}

/**
 * The nearest overlay root's state. Content wrappers stay mounted while
 * closed (Radix hides the content itself), so they claim Escape (see
 * `escape.ts`) only while `open`.
 */
export const OverlayContext = createContext<{ open: boolean; close: () => void }>({
  open: false,
  close: () => {},
});

export function useOverlay() {
  return useContext(OverlayContext);
}

/** The context value for a root, stable while its state is. */
export function useOverlayValue(open: boolean, setOpen: (open: boolean) => void) {
  return useMemo(() => ({ open, close: () => setOpen(false) }), [open, setOpen]);
}
