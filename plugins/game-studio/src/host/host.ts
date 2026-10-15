import { discover, probe, alive, execute, job, quiet } from "./unity-editors.ts";
import {
  inspectRampageWorkspace,
  assertWorkspaceStopped,
  resolveWorkspacePath,
  planSlotDestination,
} from "./slot-workspaces.ts";
import { provisionRampageSlot, assertNoSlotPreparation } from "./slot-provisioning.ts";

import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { studioHostContract } from "../shared/host-contract.ts";
import { GenerationRunner } from "./generation.ts";

const runner = new GenerationRunner();
export default experimental_defineHostEntry({
  contract: studioHostContract,
  handlers: {
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
    execute: (input, ctx) => execute(input.instance, input.command, input.parameters, ctx.signal),
    job: ({ instance, jobId }, ctx) =>
      job(instance, jobId, ctx.signal, ctx.experimental_paths.dataDir),
    async start(input, context) {
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
    list: (input) => runner.list(input.rootPath),
    cancel: (input) => runner.cancel(input),
    async resume(input, context) {
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
  dispose: () => runner.dispose(),
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
