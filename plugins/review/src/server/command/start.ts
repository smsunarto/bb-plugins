import { defineCommand, PluginCliError, type CommandContext } from "@bb-kit/core/command";
import type { Context } from "@bb-kit/core/plugin";
import { isAbsolute, resolve } from "node:path";
import { pickReviewer, REVIEW_TITLE, reviewerPrompt, type ReviewerModels } from "../lib/review.ts";

type StartContext = CommandContext<Context<{ reviewerModels(): Promise<ReviewerModels> }>>;

export const start = defineCommand({
  summary: "Spawn a hidden adversarial reviewer for the calling thread's work",
  options: {
    file: {
      type: "string",
      description: "Brief file on the calling machine: the goal, the changed files, what to attack",
      placeholder: "path",
    },
    prompt: { type: "string", description: "Brief text, instead of --file", placeholder: "text" },
  },
  constraints: [{ kind: "exactly-one", options: ["file", "prompt"] }],
  async execute(ctx: StartContext, { options }) {
    const threadId = ctx.threadId;
    if (!threadId) {
      throw new PluginCliError("bb review start must run inside a bb thread", {
        code: "no_thread",
        hint: "Run it from an agent's shell, where BB_THREAD_ID is set.",
      });
    }
    const brief = options.prompt ?? (await readBrief(ctx, threadId, options.file ?? ""));
    if (!brief.trim()) throw new PluginCliError("The brief is empty", { code: "empty_brief" });

    const [thread, models] = await Promise.all([
      ctx.bb.sdk.threads.get({ threadId }),
      ctx.reviewerModels(),
    ]);
    if (thread.originPluginId === ctx.bb.pluginId) {
      throw new PluginCliError("Reviewer threads cannot start another review", {
        code: "nested_review",
      });
    }
    if (!thread.environmentId) {
      throw new PluginCliError("This thread has no environment to review", {
        code: "no_environment",
      });
    }
    const reviewer = pickReviewer(
      {
        providerId: thread.providerId,
        // These providers serve one family. Other providers can switch families per turn.
        model: ["codex", "claude-code"].includes(thread.providerId)
          ? null
          : await authorModel(ctx, threadId),
      },
      models,
    );
    const child = await ctx.bb.sdk.threads.spawn({
      projectId: thread.projectId,
      environment: { type: "reuse", environmentId: thread.environmentId },
      parentThreadId: threadId,
      visibility: "hidden",
      title: REVIEW_TITLE,
      providerId: reviewer.providerId,
      model: reviewer.model,
      reasoningLevel: reviewer.reasoningLevel,
      serviceTier: reviewer.serviceTier,
      prompt: reviewerPrompt(brief),
    });
    return {
      exitCode: 0,
      stdout: [
        `Reviewer ${child.id} started on ${reviewer.providerId} ${reviewer.model}.`,
        `Wait: bb thread wait ${child.id} --timeout 90s`,
        "Repeat the wait if it times out. The review is still running.",
        `Findings: bb thread output ${child.id}`,
        "",
      ].join("\n"),
    };
  },
});

/** Match the first accepted input of the latest turn to its recorded execution.
 * Next-turn overrides and later steering inputs do not describe the author model.
 */
async function authorModel(ctx: StartContext, threadId: string): Promise<string> {
  const events = ctx.bb.sdk.threads.events;
  const [started] = await events.list({
    threadId,
    types: ["turn/started"],
    order: "desc",
    limit: "1",
  });
  if (!started || started.scope.kind !== "turn") {
    throw new PluginCliError("This thread has no recorded author turn", { code: "no_author_turn" });
  }
  const [accepted] = await events.list({
    threadId,
    types: ["turn/input/accepted"],
    afterSeq: String(started.seq),
    order: "asc",
    limit: "1",
  });
  if (
    accepted?.type !== "turn/input/accepted" ||
    accepted.scope.kind !== "turn" ||
    accepted.scope.turnId !== started.scope.turnId
  ) {
    throw new PluginCliError("The author turn has no recorded accepted input", {
      code: "no_author_input",
    });
  }
  let beforeSeq = String(accepted.seq);
  for (;;) {
    const requests = await events.list({
      threadId,
      types: ["client/turn/requested"],
      beforeSeq,
      order: "desc",
      limit: "100",
    });
    for (const request of requests) {
      if (
        request.type === "client/turn/requested" &&
        request.data.requestId === accepted.data.clientRequestId
      ) {
        return request.data.execution.model;
      }
    }
    const oldest = requests.at(-1);
    if (!oldest) {
      throw new PluginCliError("The author turn has no recorded execution model", {
        code: "no_author_model",
      });
    }
    beforeSeq = String(oldest.seq);
  }
}

/** The path names a file on the calling machine, which may not be the server. */
async function readBrief(ctx: StartContext, threadId: string, path: string): Promise<string> {
  if (!isAbsolute(path) && !ctx.cwd) {
    throw new PluginCliError("Pass an absolute --file path", { code: "relative_path" });
  }
  const { hostId } = await ctx.bb.sdk.threads.storageLocation({ threadId });
  const file = await ctx.bb.sdk.files.read({ hostId, path: resolve(ctx.cwd ?? "/", path) });
  if (file.contentEncoding !== "utf8") {
    throw new PluginCliError(`${path} is not UTF-8 text`, { code: "binary_brief" });
  }
  return file.content;
}
