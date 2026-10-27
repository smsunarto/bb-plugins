// Magic Compose, while it is on: the draft is routed again as it changes and the
// composer's pickers follow it. This is the scheduling alone, free of React and
// the DOM so it can be tested. It decides when to ask Jev and says, through
// `pending`, when the draft on screen has not been decided yet, which is what
// holds the send button.

/** Let a burst of typing get going before its first request: no routing "F". */
export const FIRST_DELAY_MS = 300;
/** At most one request starts per this long, however fast the typing. */
export const THROTTLE_MS = 600;
/** With the pace set to "pause": how long typing must stop before Jev is asked. */
export const PAUSE_MS = 700;
/** A round slower than this fails, so send is never held for good. */
export const ROUND_TIMEOUT_MS = 8_000;

export interface LiveFillSnapshot {
  enabled: boolean;
  /** The draft on screen has not been routed and applied yet. */
  pending: boolean;
  /** Why the last round failed. Cleared when the draft changes or a round succeeds. */
  error: string | null;
}

export interface LiveFillDeps<Selection> {
  /** Ask Jev where `text` should run. */
  route(text: string): Promise<Selection>;
  /** Set the composer to `selection`. `previous` is what was applied last, null at first. */
  apply(selection: Selection, previous: Selection | null): Promise<void>;
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface LiveFill {
  setEnabled(enabled: boolean): void;
  /** "typing" asks as the draft changes, throttled. "pause" waits for typing to stop. */
  setPace(pace: "typing" | "pause"): void;
  /** The draft's current text. Surrounding whitespace is ignored. */
  setText(text: string): void;
  /** Put a failure behind and try the current draft again. */
  retry(): void;
  /** Forget what was decided and applied, and decide the draft afresh. */
  reset(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): LiveFillSnapshot;
  dispose(): void;
}

const OFF: LiveFillSnapshot = { enabled: false, pending: false, error: null };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLiveFill<Selection>(deps: LiveFillDeps<Selection>): LiveFill {
  const listeners = new Set<() => void>();
  let enabled = false;
  let pace: "typing" | "pause" = "typing";
  let lastChangeAt = 0;
  let text = "";
  /** The text whose selection the composer holds now. */
  let settledText: string | null = null;
  let applied: Selection | null = null;
  let error: string | null = null;
  /** When the draft last went from decided to undecided. */
  let dirtySince = 0;
  let lastStartAt = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  let timer: unknown = null;
  /** Names the round whose result still counts. Bumped to disown one in the air. */
  let roundId = 0;
  let snapshot = OFF;

  const undecided = () => enabled && text !== "" && text !== settledText;

  function publish(): void {
    const next: LiveFillSnapshot = {
      enabled,
      // A failed round lets the draft go rather than hold it on a broken connection.
      pending: undecided() && error === null,
      error,
    };
    if (
      next.enabled === snapshot.enabled &&
      next.pending === snapshot.pending &&
      next.error === snapshot.error
    ) {
      return;
    }
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  function cancelTimer(): void {
    if (timer === null) return;
    deps.clearTimer(timer);
    timer = null;
  }

  function schedule(): void {
    if (!undecided() || error !== null) {
      cancelTimer();
      return;
    }
    // One round at a time; the one in the air schedules the next as it lands.
    if (inFlight) return;
    if (pace === "pause") {
      // Every keystroke pushes the request back until typing stops.
      cancelTimer();
    } else if (timer !== null) {
      // A throttle: more typing does not push the next request back.
      return;
    }
    const dueAt =
      pace === "pause"
        ? lastChangeAt + PAUSE_MS
        : Math.max(dirtySince + FIRST_DELAY_MS, lastStartAt + THROTTLE_MS);
    timer = deps.setTimer(
      () => {
        timer = null;
        void round();
      },
      Math.max(0, dueAt - deps.now()),
    );
  }

  async function round(): Promise<void> {
    if (!undecided() || inFlight) return;
    roundId += 1;
    const id = roundId;
    const alive = () => id === roundId;
    const routed = text;
    inFlight = true;
    lastStartAt = deps.now();
    let timeout: unknown = null;
    try {
      const work = (async () => {
        const selection = await deps.route(routed);
        if (!alive()) return;
        await deps.apply(selection, applied);
        if (!alive()) return;
        applied = selection;
        settledText = routed;
      })();
      // Should the timeout win, this round's own failure must not go unhandled.
      work.catch(() => undefined);
      const limit = new Promise<never>((_, reject) => {
        timeout = deps.setTimer(
          () => reject(new Error("Magic Compose took too long to decide.")),
          ROUND_TIMEOUT_MS,
        );
      });
      await Promise.race([work, limit]);
    } catch (cause) {
      if (alive()) error = messageOf(cause);
    } finally {
      if (timeout !== null) deps.clearTimer(timeout);
    }
    // Magic Compose went off, or came back on, while this round was out.
    if (!alive()) return;
    // Disown whatever lost the race to the timeout.
    roundId += 1;
    inFlight = false;
    publish();
    // Typing went on meanwhile: the draft is still undecided, so go again.
    schedule();
  }

  function forget(): void {
    roundId += 1;
    cancelTimer();
    settledText = null;
    applied = null;
    error = null;
    inFlight = false;
    dirtySince = deps.now();
    lastChangeAt = dirtySince;
    publish();
    schedule();
  }

  return {
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      // Turning Magic Compose on decides the draft afresh, whatever was applied before.
      forget();
    },
    reset: forget,
    setPace(next) {
      if (next === pace) return;
      pace = next;
      cancelTimer();
      schedule();
    },
    setText(raw) {
      const next = raw.trim();
      if (next === text) return;
      const wasUndecided = undecided();
      text = next;
      lastChangeAt = deps.now();
      // New text is a reason to try again after a failure.
      error = null;
      if (!wasUndecided && undecided()) dirtySince = deps.now();
      publish();
      schedule();
    },
    retry() {
      if (error === null) return;
      error = null;
      publish();
      schedule();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    dispose() {
      roundId += 1;
      enabled = false;
      cancelTimer();
      listeners.clear();
      snapshot = OFF;
    },
  };
}
