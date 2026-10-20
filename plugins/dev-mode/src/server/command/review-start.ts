import { defineCommand, PluginCliError, type CommandContext } from "@bb-kit/core/command";
import { isAbsolute, resolve } from "node:path";
import type { Context } from "@bb-kit/core/plugin";
import { requestSchema } from "../../shared/review.ts";
import type { ReviewService } from "../lib/review-service.ts";
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
  const lines = receipt.reviewers.map(
    ({ reviewer, threadId }) =>
      `${reviewer.model}: ${threadId}\nResult after BB notifies: bb thread output ${threadId}`,
  );
  for (const { reviewer, error } of receipt.errors) lines.push(`${reviewer.model}: ${error}`);
  return lines.join("\n") + "\n";
}

export const reviewStart = defineCommand({
  summary: "Start a scoped design or implementation review",
  options: {
    file: {
      type: "string",
      description: "Optional detailed brief on the calling host (instead of --prompt)",
      placeholder: "path",
    },
    prompt: {
      type: "string",
      description: "Short review summary",
      placeholder: "text",
    },
    kind: {
      type: "enum",
      values: ["design", "implementation"],
      default: "implementation",
      description: "Design before consequential work, or implementation at a fixed checkpoint",
    },
    branch: {
      type: "string",
      description:
        "Named GitButler branch; reviews its changes and ancestors, excluding other stacks",
    },
    base: {
      type: "string",
      description: "Explicit base commit/ref, with --head; excludes HEAD/workspace",
    },
    head: {
      type: "string",
      description: "Explicit head commit/ref, with --base; excludes HEAD/workspace",
    },
    json: { type: "boolean", description: "Return reviewer thread IDs as JSON" },
  },
  constraints: [{ kind: "exactly-one", options: ["file", "prompt"] }],
  async execute(ctx: CommandContext<ReviewContext>, { options }) {
    if (!ctx.threadId)
      throw new PluginCliError("bb dev-mode review-start must run inside a bb thread", {
        code: "no_thread",
      });
    const target = targetFromOptions(options);
    const brief = await readBrief(ctx, options.file);
    const parsed = requestSchema.safeParse({
      kind: options.kind,
      summary: options.prompt ?? brief?.trim().split("\n")[0]?.slice(0, 2000),
      brief,
      target,
    });
    if (!parsed.success) throw new PluginCliError(parsed.error.message, { code: "invalid_brief" });
    try {
      const receipt = await ctx.reviews.start(
        ctx.threadId,
        parsed.data,
        ctx.signal ?? new AbortController().signal,
      );
      return {
        exitCode: receipt.reviewers.length ? 0 : 1,
        stdout: options.json ? `${JSON.stringify(receipt)}\n` : receiptText(receipt),
      };
    } catch (error) {
      throw new PluginCliError(error instanceof Error ? error.message : String(error), {
        code: "review_failed",
      });
    }
  },
});
