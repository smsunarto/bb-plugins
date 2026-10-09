/**
 * `src/orb-intent.ts` — the one-shot Orb intent, held by the plugin server.
 *
 * The composer toggle arms Orb for the next Amp thread through the server's
 * RPC. The server decides which new thread takes it, because the provider
 * bridge runs on whichever machine runs the thread, and that is often not the
 * server's. Nothing the two could share on disk reaches it. The decision rides
 * to the bridge in providerOptions (`executionTarget`), and the bridge applies
 * it only when thread/start creates a fresh session record.
 *
 * The server fixes a thread's executor the first time it sees the thread:
 * when bb announces it (`thread.created`) or when bb builds its first command,
 * whichever comes first. bb may do either first. While armed, the first
 * unseen thread takes the intent and every later one finds it taken, so one
 * press sends exactly one thread to Orb.
 *
 * A command can also come from an Amp thread that existed before the press
 * but that this server process has not seen yet, for example after a restart.
 * That take is provisional. The server looks up when the thread was created,
 * and a thread older than the press hands the intent back. A thread bb
 * announces as created is new, so its take needs no check. A stale intent
 * expires so a toggle armed and abandoned cannot surprise-run Orb much later.
 *
 * The state is in memory. An intent lives ten minutes, and the executors the
 * server fixed only have to outlast the gap between creating a thread and
 * starting it: after that the bridge record fixes them.
 */
import type { AmpExecutionTarget } from "./execution-target.ts";

/** An intent older than this no longer arms Orb. */
export const ORB_INTENT_TTL_MS = 10 * 60 * 1000;

/**
 * @param threadCreatedAt when bb created the thread, in the same epoch
 *   milliseconds as `now`. Asked only for a thread that took the intent
 *   through its first command.
 */
export function createOrbIntent(
  threadCreatedAt: (threadId: string) => Promise<number>,
  now: () => number = Date.now,
) {
  let armedAt: number | null = null;
  /** Bumped by every toggle change, so a hand-back never undoes a newer one. */
  let presses = 0;
  const targets = new Map<string, AmpExecutionTarget>();

  function armed(): boolean {
    if (armedAt !== null && now() - armedAt >= ORB_INTENT_TTL_MS) armedAt = null;
    return armedAt !== null;
  }

  /** The thread's executor, fixed on first sight. Synchronous, so two
   *  threads can never both take one press. */
  function pin(threadId: string): AmpExecutionTarget {
    const pinned = targets.get(threadId);
    if (pinned !== undefined) return pinned;
    const target = armed() ? "orb" : "local";
    if (target === "orb") armedAt = null;
    targets.set(threadId, target);
    return target;
  }

  async function handBackIfOlder(threadId: string, pressedAt: number, press: number) {
    let createdAt: number;
    try {
      createdAt = await threadCreatedAt(threadId);
    } catch {
      // Unknown age: keep the take. Handing it back could send a second
      // thread to Orb.
      return;
    }
    if (createdAt >= pressedAt || targets.get(threadId) !== "orb") return;
    targets.set(threadId, "local");
    if (presses === press) armedAt = pressedAt;
  }

  return {
    armed,
    setArmed(next: boolean): void {
      armedAt = next ? now() : null;
      presses += 1;
    },
    /** bb announced a new Amp thread: it takes the armed intent unless a
     *  command fixed its executor first. */
    claim(threadId: string): void {
      pin(threadId);
    },
    /** Whether the thread's command asks the bridge for Orb. */
    runsOnOrb(threadId: string): boolean {
      const pressedAt = targets.has(threadId) || !armed() ? null : armedAt;
      const target = pin(threadId);
      if (pressedAt !== null) void handBackIfOlder(threadId, pressedAt, presses);
      return target === "orb";
    },
    forget(threadId: string): void {
      targets.delete(threadId);
    },
  };
}

export type OrbIntent = ReturnType<typeof createOrbIntent>;
