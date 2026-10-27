import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { studioHostContract } from "../shared/host-contract.ts";
import { provisionRampageSlot, assertNoSlotPreparation } from "./slot-provisioning.ts";
import {
  assertWorkspaceStopped,
  inspectRampageWorkspace,
  planSlotDestination,
  resolveWorkspacePath,
} from "./slot-workspaces.ts";
import { alive, discover, job, probe, quiet } from "./unity-editors.ts";

/*
 * The machine side of the plugin. Canvas files, media and generation jobs live in the Game
 * Studio web app now; what remains here needs a machine: Unity Editors and checkout slots.
 */
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
    job: ({ instance, jobId }, ctx) =>
      job(instance, jobId, ctx.signal, ctx.experimental_paths.dataDir),
  },
});
