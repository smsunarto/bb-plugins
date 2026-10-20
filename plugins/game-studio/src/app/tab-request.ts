/**
 * Carries the tab a launcher asked a game's panel to show. It travels beside the panel params,
 * because BB opens a separate panel tab for each distinct params value. Only the panel whose params
 * name the game takes it, wherever that panel has navigated since.
 */
export function createTabRequests<Tab extends string>() {
  let pending: { gameId: string; tab: Tab } | null = null;
  const changes = new EventTarget();
  const matching = (paramGame: string | undefined) =>
    paramGame && pending?.gameId === paramGame ? pending : null;
  return {
    /** Replaces any request nobody took, so a stale one cannot fire on a later open. */
    request(gameId: string, tab: Tab | undefined) {
      pending = tab ? { gameId, tab } : null;
      if (pending) changes.dispatchEvent(new Event("change"));
    },
    peek: (paramGame: string | undefined) => matching(paramGame),
    take(paramGame: string | undefined) {
      const found = matching(paramGame);
      if (found) pending = null;
      return found;
    },
    subscribe(listener: () => void) {
      changes.addEventListener("change", listener);
      return () => changes.removeEventListener("change", listener);
    },
  };
}
