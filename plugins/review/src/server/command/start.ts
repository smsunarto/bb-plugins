import { defineCommand, PluginCliError, type CommandContext } from "@bb-kit/core/command";
import { isAbsolute, resolve } from "node:path";
import type { Context } from "@bb-kit/core/plugin";
import { requestSchema } from "../../shared/schema.ts";
import type { ReviewService } from "../lib/service.ts";
export type ReviewContext = Context<{ reviews: ReviewService }>;

async function readBrief(ctx: CommandContext<ReviewContext>, path: string | undefined) {
  if (!path) return undefined;
  if (!isAbsolute(path) && !ctx.cwd)
    throw new PluginCliError("Pass an absolute --file path", { code: "relative_path" });
  const { hostId } = await ctx.bb.sdk.threads.storageLocation({ threadId: ctx.threadId! });
  const file = await ctx.bb.sdk.files.read({ hostId, path: resolve(ctx.cwd ?? "/", path) });
  if (file.contentEncoding !== "utf8")
    throw new PluginCliError("Brief must be UTF-8 text", { code: "binary_brief" });
  return file.content;
}
function targetFromOptions(options: { branch?: string; base?: string; head?: string }) {
  if (options.branch && (options.base || options.head))
    throw new PluginCliError("Choose --branch or --base with --head", { code: "invalid_target" });
  if (Boolean(options.base) !== Boolean(options.head))
    throw new PluginCliError("--base and --head must be supplied together", {
      code: "invalid_target",
    });
  if (options.branch) return { branch: options.branch };
  if (options.base && options.head) return { base: options.base, head: options.head };
  return undefined;
}
function receiptText(receipt: Awaited<ReturnType<ReviewService["start"]>>) {
  const reviewers = receipt.reviewers
    .map((reviewer, index) => `${reviewer.model} ${receipt.threadIds[index] ?? "dispatching"}`)
    .join(", ");
  const lines = [`Review run ${receipt.runId} (${receipt.mode} ${receipt.kind}): ${reviewers}.`];
  if (receipt.reused) lines.push("Reused an existing run/reviewer.");
  lines.push(`Result: bb review result ${receipt.runId}`);
  if ("message" in receipt && typeof receipt.message === "string") lines.push(receipt.message);
  return lines.join("\n") + "\n";
}

export const start = defineCommand({
  summary: "Start or reuse a scoped design or implementation review",
  options: {
    file: {
      type: "string",
      description: "Optional detailed brief on the calling host (instead of --prompt)",
      placeholder: "path",
    },
    prompt: {
      type: "string",
      description: "Short review summary; additional context is disclosed lazily",
      placeholder: "text",
    },
    kind: {
      type: "enum",
      values: ["design", "implementation"],
      default: "implementation",
      description: "Design before consequential work, or implementation at a fixed checkpoint",
    },
    mode: {
      type: "enum",
      values: ["quick", "standard", "deep"],
      default: "standard",
      description: "Quick medium, Standard high, Deep max",
    },
    branch: {
      type: "string",
      description:
        "Applied GitButler branch; reviews its full changeset from the workspace merge base",
    },
    base: {
      type: "string",
      description: "Explicit base commit/ref, with --head; excludes HEAD/workspace",
    },
    head: {
      type: "string",
      description: "Explicit head commit/ref, with --base; excludes HEAD/workspace",
    },
    reuse: {
      type: "enum",
      values: ["auto", "new"],
      default: "auto",
      description: "Reuse an eligible idle reviewer or request fresh judgment",
    },
    "review-thread": {
      type: "string",
      description: "Reuse this eligible idle reviewer instead of automatic selection",
    },
    workstream: {
      type: "string",
      description: "Stable workstream label for design-to-implementation reuse",
    },
    json: { type: "boolean", description: "Return the run receipt as JSON" },
  },
  constraints: [{ kind: "exactly-one", options: ["file", "prompt"] }],
  async execute(ctx: CommandContext<ReviewContext>, { options }) {
    if (!ctx.threadId)
      throw new PluginCliError("bb review start must run inside a bb thread", {
        code: "no_thread",
      });
    const target = targetFromOptions(options);
    const brief = await readBrief(ctx, options.file);
    const parsed = requestSchema.safeParse({
      kind: options.kind,
      mode: options.mode,
      summary: options.prompt ?? brief?.trim().split("\n")[0]?.slice(0, 2000),
      brief,
      workstream: options.workstream,
      target,
      reuse: options["review-thread"] ? { threadId: options["review-thread"] } : options.reuse,
    });
    if (!parsed.success) throw new PluginCliError(parsed.error.message, { code: "invalid_brief" });
    try {
      const receipt = await ctx.reviews.start(
        ctx.threadId,
        parsed.data,
        ctx.signal ?? new AbortController().signal,
      );
      return {
        exitCode: 0,
        stdout: options.json ? `${JSON.stringify(receipt)}\n` : receiptText(receipt),
      };
    } catch (error) {
      throw new PluginCliError(error instanceof Error ? error.message : String(error), {
        code: "review_failed",
      });
    }
  },
});
