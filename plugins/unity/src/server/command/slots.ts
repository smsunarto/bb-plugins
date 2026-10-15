import { defineCommand, type CommandContext } from "@bb-kit/core/command";
import { slotActionSchema } from "../../shared/slot-contract.ts";
import { slotAction, type SlotsContext } from "../lib/slot-action.ts";

export const slots = defineCommand({
  summary: "Manage persistent Rampage checkout slots and exclusive thread leases",
  positionals: [
    {
      name: "action",
      required: true,
      description: "list | register | acquire | release | recover | retire",
    },
  ],
  options: {
    host: { type: "string", description: "Enrolled host; defaults to this thread's host" },
    project: { type: "string", description: "BB project ID for registration or listing" },
    path: { type: "string", description: "Existing independent Rampage checkout to register" },
    slot: { type: "string", description: "Registered slot ID" },
    lease: { type: "string", description: "Lease capability returned by acquire" },
    note: { type: "string", description: "Observed completion evidence for recovery" },
    confirm: { type: "boolean", description: "Confirm no owned background work remains" },
  },
  async execute(ctx: CommandContext<SlotsContext>, input) {
    const o = input.options;
    const result = await slotAction(
      ctx,
      slotActionSchema.parse({
        action: input.positionals.action,
        hostId: o.host,
        projectId: o.project,
        path: o.path,
        slotId: o.slot,
        leaseId: o.lease,
        note: o.note,
        confirmNoPendingWork: o.confirm ?? false,
      }),
      ctx.threadId,
      ctx.signal,
    );
    return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
  },
});
