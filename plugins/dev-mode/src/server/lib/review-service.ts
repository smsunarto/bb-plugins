import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { reviewHostContract } from "../../shared/review-host-contract.ts";
import { assignmentSchema } from "../../shared/review.ts";
import type { ContextRequest, Evidence, ReviewRequest, Reviewer } from "../../shared/review.ts";
import { reviewerPrompt, type ReviewerModels } from "./review.ts";

/** Reviews are ordinary BB children. Only their immutable inputs live in thread metadata. */
export class ReviewService {
  private readonly bb: BbPluginApi;
  private readonly models: () => Promise<ReviewerModels>;
  constructor(bb: BbPluginApi, models: () => Promise<ReviewerModels>) {
    this.bb = bb;
    this.models = models;
  }

  private readHost() {
    return this.bb.hosts.experimental_client({ contract: reviewHostContract });
  }

  async start(caller: string, request: ReviewRequest, signal: AbortSignal) {
    const thread = await this.bb.sdk.threads.get({
      threadId: caller,
      include: "environment",
      signal,
    });
    if ([this.bb.pluginId, "review"].includes(thread.originPluginId ?? ""))
      throw new Error("Workers cannot start another review");
    const environment = "environment" in thread ? thread.environment : undefined;
    if (!environment?.path || environment.status !== "ready")
      throw new Error("This thread needs a ready project environment");
    if (request.kind === "implementation" && !request.target)
      throw new Error("Implementation review needs a named GitButler branch or explicit base/head");
    const target = request.target
      ? await this.readHost().call(
          "reviewSnapshot",
          { environmentPath: environment.path, target: request.target },
          { hostId: environment.hostId, signal },
        )
      : null;
    const models = await this.models();
    const reviewers: Reviewer[] = [
      {
        providerId: "claude-code",
        model: models.claudeModel,
        reasoningLevel: "high",
        serviceTier: "fast",
      },
      {
        providerId: "codex",
        model: models.codexModel,
        reasoningLevel: "high",
        serviceTier: "fast",
      },
    ];
    const evidence = await this.captureEvidence(environment.hostId, request.evidence, signal);
    const prompt = reviewerPrompt(request, target, evidence);
    const reviewRun = {
      id: randomUUID(),
      kind: request.kind,
      summary: request.summary,
      target,
    };
    const children: { threadId: string; reviewer: Reviewer }[] = [];
    const errors: { reviewer: Reviewer; error: string }[] = [];
    for (const reviewer of reviewers) {
      signal.throwIfAborted();
      try {
        const child = await this.bb.sdk.threads.spawn({
          projectId: thread.projectId,
          environment: { type: "reuse", environmentId: environment.id },
          parentThreadId: caller,
          visibility: "hidden",
          title: `${request.kind} review (${reviewer.providerId === "claude-code" ? "Claude" : "Codex"})`,
          ...reviewer,
          pluginMetadata: { reviewRun },
          prompt,
        });
        children.push({ threadId: child.id, reviewer });
      } catch (error) {
        errors.push({ reviewer, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { target, reviewers: children, errors };
  }

  private async captureEvidence(
    hostId: string,
    refs: ReviewRequest["evidence"],
    signal: AbortSignal,
  ) {
    const evidence: Evidence[] = [];
    for (const ref of refs) {
      const file = await this.bb.sdk.files.read({
        hostId: hostId,
        path: ref.path,
        signal,
      });
      if (file.contentEncoding !== "utf8" || Buffer.byteLength(file.content, "utf8") > 12288)
        throw new Error("Evidence must be UTF-8 text up to 12 KiB per reference");
      evidence.push({ ...ref, text: file.content });
    }
    return evidence;
  }

  private async assignment(caller: string, threadId: string, signal: AbortSignal) {
    const thread = await this.bb.sdk.threads.get({ threadId, include: "environment", signal });
    if (
      thread.originPluginId !== this.bb.pluginId ||
      (caller !== thread.id && caller !== thread.parentThreadId)
    )
      throw new Error("Only the reviewer and its parent can read this review");
    const metadata = await this.bb.sdk.threads.getPluginMetadata({
      threadId,
      pluginId: this.bb.pluginId,
      signal,
    });
    return { thread, assignment: assignmentSchema.parse(metadata.reviewRun) };
  }

  async context(caller: string, input: ContextRequest, signal: AbortSignal) {
    const { thread, assignment } = await this.assignment(caller, input.threadId ?? caller, signal);
    if (!assignment.target)
      throw new Error(
        "This design review has no repository target; its brief is in the initial prompt",
      );
    const environment = "environment" in thread ? thread.environment : undefined;
    if (!environment) throw new Error("The reviewer environment is unavailable");
    return this.readHost().call(
      "reviewRead",
      {
        target: assignment.target,
        section: input.section,
        ...(input.path === undefined ? {} : { path: input.path }),
        side: input.side,
        offset: input.offset,
      },
      { hostId: environment.hostId, signal },
    );
  }
}
