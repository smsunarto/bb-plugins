import { discover, probe, alive, job, quiet } from "./unity-editors.ts";
import {
  inspectRampageWorkspace,
  assertWorkspaceStopped,
  resolveWorkspacePath,
  planSlotDestination,
} from "./slot-workspaces.ts";
import { provisionRampageSlot, assertNoSlotPreparation } from "./slot-provisioning.ts";

import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { studioHostContract } from "../shared/host-contract.ts";
import { studioHostSignals } from "../shared/canvas-contract.ts";
import { GenerationRunner } from "./generation.ts";
import { CanvasHost, nodeDisk, readJobFiles } from "./canvas.ts";
import { collectCanvas, writers } from "./collect.ts";
import { Media } from "./media.ts";
import { runCommand } from "./providers.ts";

/** Staged media lives in this plugin's host data directory, which every call names. */
const media = new Media();
const runner = new GenerationRunner(runCommand, media);
const used = (context: { experimental_paths: { dataDir: string } }) =>
  media.use(context.experimental_paths.dataDir);
const canvas = new CanvasHost(
  nodeDisk,
  async (root) => {
    try {
      const { workspacePath } = await resolveWorkspacePath(root);
      if (!workspacePath) throw new Error("The project's checkout is unavailable.");
      // A read only reads: an interrupted job shows as uncertain without rewriting its receipt.
      return {
        workspacePath,
        jobs: await runner.list(workspacePath, { persist: false }),
        stale: false,
      };
    } catch {
      // The saved records still show; the server marks the ones it cannot vouch for.
      return { workspacePath: null, jobs: await readJobFiles(nodeDisk, root), stale: true };
    }
  },
  { media },
);
export default experimental_defineHostEntry({
  contract: studioHostContract,
  experimental_signals: studioHostSignals,
  handlers: {
    readCanvas: (input, ctx) => (used(ctx), canvas.read(input, ctx)),
    saveCanvasBoard: (input) => canvas.saveBoard(input),
    captureCanvasInputs: (input, ctx) => (used(ctx), canvas.captureInputs(input)),
    // A switch in progress finishes first, so a writer that asks again after writing sees it.
    mediaDir: async ({ rootPath }, ctx) => ({
      dir: await used(ctx).shared(rootPath, () => media.dir(rootPath)),
    }),
    mediaWriters: ({ rootPath }) => writers(nodeDisk, runner, rootPath),
    collectCanvas: ({ rootPath, movedNote, settled, hold }, ctx) =>
      collectCanvas(rootPath, nodeDisk, runner, used(ctx), {
        signal: ctx.signal,
        note: movedNote,
        settled,
        hold,
      }),
    planSlotDestination: ({ path }) => planSlotDestination(path),
    provisionSlot: (input, ctx) =>
      provisionRampageSlot(input, ctx.experimental_paths.dataDir, ctx.signal),
    resolveWorkspace: ({ path }) => resolveWorkspacePath(path),
    inspectWorkspace: ({ path }, ctx) => inspectRampageWorkspace(path, ctx.signal),
    workspaceStopped: async ({ path }, ctx) => {
      await assertNoSlotPreparation(path, ctx.experimental_paths.dataDir);
      await assertWorkspaceStopped(path, ctx.signal);
      return { stopped: true as const };
    },
    discover: (_, ctx) => discover(ctx.signal),
    probe: ({ instance }, ctx) => probe(instance, ctx.signal),
    alive: async ({ pid, startedAt }) => ({ alive: await alive(pid, startedAt) }),
    quiet: ({ instance }, ctx) => quiet(instance, ctx.signal),
    job: ({ instance, jobId }, ctx) =>
      job(instance, jobId, ctx.signal, ctx.experimental_paths.dataDir),
    async start(input, context) {
      used(context);
      const lease = context.experimental_retainWorker();
      try {
        const result = await runner.start(input);
        retainUntilDone(input, lease, context.lifecycle.signal);
        return result;
      } catch (error) {
        await lease.dispose();
        throw error;
      }
    },
    status: (input) => runner.status(input),
    reconcileMissing: (input) => runner.reconcileMissing(input),
    stagedOutputs: (input, ctx) => (used(ctx), runner.stagedOutputs(input)),
    list: (input) => runner.list(input.rootPath),
    cancel: (input) => runner.cancel(input),
    async resume(input, context) {
      used(context);
      const lease = context.experimental_retainWorker();
      try {
        const result = await runner.resume(input);
        retainUntilDone(input, lease, context.lifecycle.signal);
        return result;
      } catch (error) {
        await lease.dispose();
        throw error;
      }
    },
  },
  dispose: async () => {
    canvas.dispose();
    await runner.dispose();
  },
});

function retainUntilDone(
  target: { rootPath: string; jobId: string },
  lease: { dispose(): void | Promise<void> },
  signal: AbortSignal,
) {
  const finish = () => {
    clearInterval(timer);
    signal.removeEventListener("abort", finish);
    void lease.dispose();
  };
  const timer = setInterval(() => {
    void runner
      .status(target)
      .then((job) => {
        if (job.status !== "running" && job.status !== "queued") finish();
      })
      .catch(finish);
  }, 1000);
  timer.unref();
  signal.addEventListener("abort", finish, { once: true });
  if (signal.aborted) finish();
}
