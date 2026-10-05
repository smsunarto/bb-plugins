import { type AccountExtras, type ExtrasUpdate, NO_EXTRAS } from "./extras.ts";
import type { MenuSnapshot } from "./pool.ts";
import type { Source } from "./sources.ts";

/** Kept extras expire after six 5-minute passes in a row that learned nothing. */
const KEPT_MS = 30 * 60_000;

/** Own account-scoped observations and serialize background/manual extras refreshes. */
export function createMenuState(signal: AbortSignal, changed: () => void, now = Date.now) {
  let source: Source | null = null;
  let identity = "";
  let generation = 0;
  let error: string | null = null;
  let at: number | null = null;
  let running: Promise<void> | null = null;
  let queued = false;
  let publication = 0;
  let forcedPublication: Promise<void> | null = null;
  /** `knownAt` is the last update with at least one known field. */
  const extras = new Map<string, { value: AccountExtras; knownAt: number }>();
  const state = {
    publish(read: () => Promise<Source>, force = false): Promise<void> {
      // Opening a menu or polling cannot supersede an explicit Refresh.
      if (forcedPublication) return forcedPublication;
      const version = ++publication;
      const request = (async () => {
        try {
          const next = await read();
          if (signal.aborted || version !== publication) return;
          state.setSource(next);
        } catch {
          if (signal.aborted || version !== publication) return;
          state.failed();
        }
        if (force) await state.refresh(true);
        else void state.refresh();
      })();
      if (!force) return request;
      forcedPublication = request.finally(() => {
        forcedPublication = null;
      });
      return forcedPublication;
    },
    get source() {
      return source;
    },
    snapshot(): MenuSnapshot {
      return {
        error,
        providers: (source?.providers ?? []).map((provider) =>
          Object.assign({}, provider, {
            accounts: provider.accounts.map((account) =>
              Object.assign(
                {},
                account,
                {
                  resetCredits: null,
                  extraUsage: null,
                  resetNotice: null,
                  webResetCredits: null,
                },
                account.status === "disabled" ? {} : extras.get(account.id)?.value,
              ),
            ),
          }),
        ),
      };
    },
    setSource(next: Source) {
      const key = JSON.stringify([
        next.kind,
        next.providers.map((provider) => [
          provider.id,
          provider.accounts.map((account) => [
            account.id,
            account.identity,
            account.status === "disabled",
          ]),
        ]),
      ]);
      if (key !== identity) {
        identity = key;
        generation++;
        extras.clear();
        at = null;
        if (running) queued = true;
      }
      source = next;
      error = null;
      changed();
    },
    failed() {
      error = "Couldn't refresh usage. Showing the last reading.";
      changed();
    },
    refresh(force = false): Promise<void> {
      if (signal.aborted || !source) return Promise.resolve();
      if (running) {
        if (force) queued = true;
        return running;
      }
      if (!force && at !== null && now() - at < 300_000) return Promise.resolve();
      running = (async () => {
        try {
          let fresh = force;
          do {
            queued = false;
            const current = source!;
            const version = generation;
            let readExtras: ReturnType<Source["extras"]>;
            try {
              readExtras = current.extras(fresh);
            } catch {
              readExtras = async () => NO_EXTRAS;
            }
            await Promise.all(
              current.providers.flatMap((provider) =>
                provider.accounts
                  .filter((account) => account.status !== "disabled")
                  .map(async (account) => {
                    let result: ExtrasUpdate;
                    try {
                      result = await readExtras(provider.id, account.id);
                    } catch {
                      result = NO_EXTRAS;
                    }
                    if (signal.aborted || version !== generation) return;
                    // A missing field is unknown, so it keeps the last observation.
                    const known = Object.fromEntries(
                      Object.entries(result).filter(([, value]) => value !== undefined),
                    );
                    const kept = extras.get(account.id);
                    if (Object.keys(known).length > 0) {
                      const value = { ...(kept?.value ?? NO_EXTRAS), ...known };
                      extras.set(account.id, { value, knownAt: now() });
                    } else if (kept && now() - kept.knownAt >= KEPT_MS) {
                      extras.delete(account.id);
                    }
                  }),
              ),
            );
            // Align with the reader caches, which start when observations finish.
            at = now();
            if (!signal.aborted) changed();
            fresh = queued;
          } while (queued && !signal.aborted);
        } finally {
          // Clear in the same turn as the loop finishes. A later microtask must
          // start a new pass instead of queuing work onto a completed operation.
          running = null;
        }
      })();
      return running;
    },
  };
  return state;
}
