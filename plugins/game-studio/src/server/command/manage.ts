import { defineCommand } from "@bb-kit/core/command";
import type { CommandContext } from "@bb-kit/core/command";
import {
  editorAction,
  editorActionSchema,
  type EditorsContext,
} from "../lib/unity-editor-action.ts";

export const manage = defineCommand({
  summary: "Discover, claim, wait for, reserve and release Unity Editors by BB thread",
  positionals: [
    {
      name: "action",
      required: true,
      description:
        "list | claim | wait | reserve | request | status | release | recover | reconcile",
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
    claim: {
      type: "string",
      description: "Claim id returned by claim; selects the instance when --instance is omitted",
    },
    workspace: {
      type: "string",
      description:
        "Checkout path to reserve before opening its Editor, or to release a reservation",
    },
    mode: {
      type: "enum",
      values: ["runtime", "authoring"],
      default: "runtime",
      description: "Runtime inspection or exclusive shared-project authoring",
    },
    hold: {
      type: "boolean",
      description: "Keep the claim or reservation after this thread's turn ends",
    },
    timeout: {
      type: "integer",
      default: 120,
      min: 5,
      max: 600,
      description: "Seconds that wait blocks for the Editor to free",
    },
    reason: {
      type: "string",
      description: "Why you need the Editor; sent to its owner by request",
    },
  },
  async execute(ctx: CommandContext<EditorsContext>, input) {
    const o = input.options;
    const parsed = editorActionSchema.parse({
      action: input.positionals.action,
      hostId: o.host,
      note: o.note,
      reason: o.reason,
      confirmNoPendingWork: o.confirm ?? false,
      instanceId: o.instance,
      claimId: o.claim,
      workspacePath: o.workspace,
      mode: o.mode,
      hold: o.hold,
      timeoutSeconds: o.timeout,
    });
    return {
      exitCode: 0,
      stdout: JSON.stringify(await editorAction(ctx, parsed, ctx.threadId, ctx.signal), null, 2),
    };
  },
});
