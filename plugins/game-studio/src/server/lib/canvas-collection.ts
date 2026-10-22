import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { studioHostContract } from "../../shared/host-contract.ts";
import type { GenerationWork } from "./generation-work.ts";
import type { SlotStore } from "./slot-store.ts";
import { forgetAssets, getGame } from "./studio.ts";

/*
 * Collection keeps a canvas from growing without bound: in one host call, nodes keep the takes
 * of their newest runs (`pruneTakes`) and the host frees what nothing names (src/host/
 * collect.ts); then the catalog forgets the freed and missing files. It runs in the background,
 * after reads settle, so a slow or offline host never holds up a studio.
 */

/** How often an open studio collects its canvas. Adopting a run collects soon after. */
const COLLECT_EVERY_MS = 10 * 60_000;
const DELAY_MS = 30_000;
const SOON_MS = 5_000;
/** A sleeping host must not hold a game's collection forever. */
const CALL_TIMEOUT_MS = 2 * 60_000;
const collectionPrefix = "collect-";

export class CanvasCollection {
  private readonly bb: BbPluginApi;
  private readonly slots: SlotStore;
  private readonly work: GenerationWork;
  private readonly last = new Map<string, number>();
  private readonly running = new Set<string>();
  constructor(bb: BbPluginApi, slots: SlotStore, work: GenerationWork) {
    this.bb = bb;
    this.slots = slots;
    this.work = work;
    // A collection this server started before it restarted no longer runs; its host call
    // ended with the server's connection.
    work.settledAll(collectionPrefix);
  }

  /** Collects the game in the background, unless it ran lately or is running. */
  schedule(gameId: string, { soon = false } = {}) {
    if (this.running.has(gameId)) return;
    if (!soon && Date.now() - (this.last.get(gameId) ?? 0) < COLLECT_EVERY_MS) return;
    this.last.set(gameId, Date.now());
    this.running.add(gameId);
    const timer = setTimeout(
      () =>
        void this.collect(gameId)
          .catch((error: unknown) =>
            this.bb.log.warn(
              `Could not collect unused generations: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
          .finally(() => this.running.delete(gameId)),
      soon ? SOON_MS : DELAY_MS,
    );
    timer.unref?.();
  }

  /**
   * One collection. A registered checkout is collected only while leased, under its owner's
   * reservation, so a release waits for it and a released or seeding checkout is never touched.
   */
  async collect(gameId: string): Promise<string[]> {
    const game = await getGame(this.bb, gameId);
    const client = this.bb.hosts.experimental_client({ contract: studioHostContract });
    const options = { hostId: game.hostId, timeoutMs: CALL_TIMEOUT_MS };
    const { workspacePath } = await client.call(
      "resolveWorkspace",
      { path: game.rootPath },
      options,
    );
    if (!workspacePath) return [];
    const slot = this.slots.find(game.hostId, workspacePath);
    if (slot && (slot.state !== "leased" || !slot.ownerThreadId)) return [];
    const job = `${collectionPrefix}${Date.now()}`;
    if (slot) this.work.reserve(game.hostId, workspacePath, job, slot.ownerThreadId!);
    // The host stops at its next step when the call is cancelled or times out.
    try {
      const { deleted, missing } = await client.call(
        "collectCanvas",
        { rootPath: game.rootPath },
        options,
      );
      await forgetAssets(this.bb, game, [...deleted, ...missing]);
      return deleted;
    } finally {
      if (slot) this.work.settled(game.hostId, workspacePath, job);
    }
  }
}
