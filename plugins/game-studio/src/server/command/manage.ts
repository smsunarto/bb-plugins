import { defineCommand } from "@bb-kit/core/command";
import type { CommandContext } from "@bb-kit/core/command";
import {
  editorAction,
  editorActionSchema,
  type EditorsContext,
} from "../lib/unity-editor-action.ts";

export const manage = defineCommand({
  summary: "Discover, claim, control and release Unity Editors by BB thread",
  positionals: [
    {
      name: "action",
      required: true,
      description: "list | claim | status | command | release | recover | reconcile",
    },
  ],
  options: {
    note: { type: "string", description: "Observed completion evidence for owner reconciliation" },
    confirm: {
      type: "boolean",
      description: "Owner confirms no detached/background work remains; required with reconcile",
    },
    host: {
      type: "string",
      description: "Enrolled host id; defaults to the calling thread's host",
    },
    instance: { type: "string", description: "Exact instance id returned by list" },
    claim: { type: "string", description: "Claim id returned by claim" },
    mode: {
      type: "enum",
      values: ["runtime", "authoring"],
      default: "runtime",
      description: "Runtime inspection or exclusive shared-project authoring",
    },
    command: { type: "string", description: "Registered Unity Pipeline command name" },
    parameters: { type: "string", description: "Command parameters as a JSON object" },
  },
  async execute(ctx: CommandContext<EditorsContext>, input) {
    const o = input.options;
    const parsed = editorActionSchema.parse({
      action: input.positionals.action,
      hostId: o.host,
      note: o.note,
      confirmNoPendingWork: o.confirm ?? false,
      instanceId: o.instance,
      claimId: o.claim,
      mode: o.mode,
      command: o.command,
      parameters: o.parameters ?? "{}",
    });
    return {
      exitCode: 0,
      stdout: JSON.stringify(await editorAction(ctx, parsed, ctx.threadId, ctx.signal), null, 2),
    };
  },
});
