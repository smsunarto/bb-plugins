import { useEffect, useState } from "react";

const PAINT_GATE_MS = 250;

/**
 * Whether a list fed by a cached read is worth painting: once the read has
 * settled, or after 250 ms, because a plugin read can stay pending
 * indefinitely. Cached data from an earlier mount paints at once.
 */
export function usePaintGate(isLoading: boolean): boolean {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!isLoading || waited) return;
    const timer = setTimeout(() => setWaited(true), PAINT_GATE_MS);
    return () => clearTimeout(timer);
  }, [isLoading, waited]);
  return !isLoading || waited;
}
