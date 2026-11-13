/**
 * Work an agent names by path or branch (`::source-control{path branch}`):
 * a checkout other than the one bb placed its thread on, such as another
 * repository or a worktree, or another branch of its own. Only the thread's
 * own host is asked, and only while a card for it is on screen.
 *
 * The checkout's read is stored with every other checkout's, so a row is
 * served from the store. The path joins no list: bb's lists stay the
 * checkouts threads are placed on.
 */
import { Effect } from "effect";
import {
  changeKeyForBranch,
  EMPTY_FACET,
  findBranch,
  type Placement,
  type ThreadChange,
} from "../core/change.ts";
import {
  checkoutWorkTag,
  parseCheckoutWorkKey,
  type CheckoutTarget,
  type CheckoutWork,
} from "../core/checkout-work.ts";
import type { ChangeKey } from "../core/ids.ts";
import type { LocalReads } from "./local-read.ts";
import { checkoutId, type Placements } from "./placement.ts";
import { localMatch } from "./review-change.ts";
import type { Store } from "./store.ts";

/** A card on screen reads its checkout again this often; the thread's turn ending reads it at once. */
export const CHECKOUT_WORK_MS = 60_000;

const NOT_READ: CheckoutWork = { row: { state: "pending" }, reviewable: false };
const none = (reason: string): CheckoutWork => ({
  row: { state: "none", reason },
  reviewable: false,
});

export function createCheckoutWork(deps: {
  store: Store;
  placements: Pick<Placements, "settle">;
  local: Pick<LocalReads, "readCheckout">;
  /** Read the Change's pull request now. */
  readForge: (key: ChangeKey) => Effect.Effect<void>;
  invalidate: (tags: readonly string[]) => void;
}) {
  const { store } = deps;
  /** Cards on screen, by key. */
  const watching = new Map<string, number>();
  /** Checkouts whose read found no repository: a stored read says nothing about those. */
  const unreadable = new Set<string>();

  const placementOf = (target: CheckoutTarget): Placement | null => {
    const where = store.placement(target.threadId);
    if (where?.state !== "checkout") return null;
    return target.path === null ? where.placement : { ...where.placement, path: target.path };
  };

  /** The named work from the store alone. */
  function work(target: CheckoutTarget): CheckoutWork {
    const where = store.placement(target.threadId);
    if (!where) return NOT_READ;
    if (where.state === "none") return { row: where, reviewable: false };
    const placement = placementOf(target)!;
    if (unreadable.has(checkoutId(placement)))
      return none(`No git repository bb can read at ${placement.path} on ${placement.hostName}.`);
    const local = store.local(placement.hostId, placement.path);
    const workspace = local.read?.value ?? null;
    const name = target.branch ?? workspace?.checkedOut ?? null;
    if (workspace && name === null)
      return none(`${placement.path} has several branches applied. Name one with branch="…".`);
    const branch = workspace ? findBranch(workspace, name) : null;
    if (workspace && !branch) return none(`${name} is not a branch in ${placement.path}.`);
    const key =
      workspace && branch ? changeKeyForBranch(placement.hostId, workspace, branch) : null;
    const forge = key ? store.forge(key) : EMPTY_FACET;
    const row: ThreadChange = {
      state: "checkout",
      placement,
      readAsGit: store.readAs(placement.hostId, placement.path) === "git",
      branch: branch ? name : null,
      key,
      local,
      forge,
    };
    return {
      row,
      reviewable: key !== null && (localMatch(store, key) !== null || !!forge.read?.value),
    };
  }

  /** What a reader would see, without the times of the reads behind it. */
  const seen = (target: CheckoutTarget): string => {
    const { row, reviewable } = work(target);
    return row.state === "checkout"
      ? JSON.stringify([
          row.branch,
          row.key,
          row.local.read?.value ?? null,
          row.local.problem,
          row.forge.read?.value ?? null,
          row.forge.problem,
          reviewable,
        ])
      : JSON.stringify(row);
  };

  /** Read the checkout and its branch's pull request now; announce the card if either moved. */
  const settle = Effect.fn("settleCheckoutWork")(function* (key: string) {
    const target = parseCheckoutWorkKey(key);
    if (!target) return;
    const before = seen(target);
    if (!store.placement(target.threadId))
      yield* Effect.ignore(deps.placements.settle(target.threadId));
    const placement = placementOf(target);
    if (placement) {
      const readAt = store.local(placement.hostId, placement.path).read?.at;
      yield* Effect.ignore(deps.local.readCheckout(placement));
      const facet = store.local(placement.hostId, placement.path);
      const id = checkoutId(placement);
      // A read that stored neither a new value nor a problem found no repository there, as
      // after a worktree is removed: the last stored read is no longer this checkout's.
      if (facet.problem === null && facet.read?.at === readAt) unreadable.add(id);
      else unreadable.delete(id);
      const { row } = work(target);
      if (row.state === "checkout" && row.key) yield* Effect.ignore(deps.readForge(row.key));
    }
    if (seen(target) !== before) deps.invalidate([checkoutWorkTag(key)]);
  });

  /** Stored rows only: serving a read never calls a host. */
  const read = (keys: readonly string[]): Record<string, CheckoutWork> =>
    Object.fromEntries(
      keys.map((key) => {
        const target = parseCheckoutWorkKey(key);
        return [key, target ? work(target) : none("This card names no checkout bb can read.")];
      }),
    );

  return {
    read,
    handlers: { workAtCheckout: ({ keys }: { keys: readonly string[] }) => read(keys) },
    /** While a card for the key is on screen: read now, then once a minute. */
    watch: (key: string) =>
      Effect.gen(function* () {
        watching.set(key, (watching.get(key) ?? 0) + 1);
        while (true) {
          yield* settle(key);
          yield* Effect.sleep(CHECKOUT_WORK_MS);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const left = (watching.get(key) ?? 1) - 1;
            if (left > 0) watching.set(key, left);
            else watching.delete(key);
          }),
        ),
      ),
    /** The thread's turn ended, as after Ship it: the cards on screen for it read again at once. */
    turnEnded: (threadId: string) =>
      Effect.forEach(
        [...watching.keys()].filter((key) => parseCheckoutWorkKey(key)?.threadId === threadId),
        settle,
        { concurrency: 3, discard: true },
      ),
  };
}

export type CheckoutWorkReads = ReturnType<typeof createCheckoutWork>;
