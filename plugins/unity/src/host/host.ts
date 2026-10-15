import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { unityHostContract } from "../shared/unity-editor-contract.ts";
import { discover, probe, alive, execute, job, quiet } from "./unity-editors.ts";
import {
  inspectRampageWorkspace,
  assertWorkspaceStopped,
  resolveWorkspacePath,
  planSlotDestination,
} from "./slot-workspaces.ts";
import { provisionRampageSlot, assertNoSlotPreparation } from "./slot-provisioning.ts";

export default experimental_defineHostEntry({
  contract: unityHostContract,
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
  },
});
