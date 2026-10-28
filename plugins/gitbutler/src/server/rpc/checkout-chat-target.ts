import type { z } from "zod";
import type { GitButlerContext } from "../lib/context.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  checkoutChatTargetInputSchema,
  checkoutChatTargetSchema,
  type CheckoutChatTarget,
} from "../../shared/schema.ts";
import { locateRepository } from "../lib/subthreads.ts";
import { hostClient, MOVED } from "../lib/target.ts";

const PAGE = 100;
type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

function reusable(environment: Environment, projectId: string, hostId: string): boolean {
  return (
    environment.projectId === projectId &&
    environment.hostId === hostId &&
    environment.path !== null &&
    environment.status === "ready" &&
    environment.lifecycle.phase === "active" &&
    environment.hostLifecycle === "active"
  );
}

function unavailable(reason: string): CheckoutChatTarget {
  return { state: "unavailable", reason };
}

function sameParent(before: Thread, after: Thread): boolean {
  const previous = "environment" in before ? before.environment : undefined;
  const current = "environment" in after ? after.environment : undefined;
  return (
    after.projectId === before.projectId &&
    after.environmentId === before.environmentId &&
    current?.path === previous?.path &&
    current?.hostId === previous?.hostId &&
    current?.status === "ready"
  );
}

/** Native reuse choices are drawn from visible, unarchived sidebar threads. */
async function selectable(bb: BbPluginApi, environment: Environment): Promise<boolean> {
  for (let offset = 0; ; offset += PAGE) {
    const threads = await bb.sdk.threads.list({
      projectId: environment.projectId,
      environmentId: environment.id,
      archived: false,
      includeHidden: false,
      limit: PAGE,
      offset,
    });
    if (
      threads.some(
        (thread) =>
          thread.environmentId === environment.id &&
          thread.projectId === environment.projectId &&
          thread.environmentHostId === environment.hostId &&
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          thread.visibility === "visible",
      )
    )
      return true;
    if (threads.length < PAGE) return false;
  }
}

export const checkoutChatTargetContract = {
  input: checkoutChatTargetInputSchema,
  output: checkoutChatTargetSchema,
};

/** Resolves a draft target without starting an agent, adopting a path, or claiming a checkout. */
export async function checkoutChatTarget(
  ctx: GitButlerContext,
  {
    threadId,
    environmentId,
    checkout,
    repositoryKey,
  }: z.output<typeof checkoutChatTargetContract.input>,
): Promise<z.input<typeof checkoutChatTargetContract.output>> {
  const parent = await ctx.bb.sdk.threads.get({ threadId, include: "environment" });
  const parentEnvironment = "environment" in parent ? parent.environment : undefined;
  if (!parentEnvironment?.path || parentEnvironment.status !== "ready")
    return unavailable("This thread needs a ready project environment before opening a chat.");
  if (environmentId && parentEnvironment.id !== environmentId) throw new Error(MOVED);
  const host = await ctx.bb.sdk.hosts.get({ hostId: checkout.hostId });
  if (host.status !== "connected" || host.lifecycle.phase !== "active")
    return unavailable(`${host.name} must be connected and active before opening a chat.`);

  // The host validates selected-path provenance against BB's roots, Git's registry and origin.
  const repository = await locateRepository(
    ctx.bb,
    threadId,
    repositoryKey,
    parentEnvironment.id,
    checkout,
  );
  const client = hostClient(ctx.bb);
  const matches: Environment[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const environments = await ctx.bb.sdk.environments.list({
      projectId: parent.projectId,
      hostId: repository.hostId,
      status: "ready",
      limit: PAGE,
      offset,
    });
    await Promise.all(
      environments
        .filter(
          (environment) =>
            reusable(environment, parent.projectId, repository.hostId) &&
            (environment.path === repository.path || environment.path === checkout.path),
        )
        .map(async (environment) => {
          // A wrapper environment's repos/* child is not an exact-checkout environment.
          const { identity } = await client.call(
            "checkoutIdentity",
            { environmentPath: environment.path!, repositoryKey: "." },
            { hostId: repository.hostId },
          );
          if (
            identity.path === repository.path &&
            identity.origin === repository.identity?.origin &&
            identity.commonDir === repository.identity?.commonDir
          )
            matches.push(environment);
        }),
    );
    if (environments.length < PAGE) break;
  }
  if (matches.length !== 1)
    return unavailable(
      matches.length
        ? "More than one BB environment matches this checkout. Open its existing thread to choose the intended environment."
        : "This checkout needs its own ready BB environment and a visible, unarchived thread before opening a new chat here.",
    );
  const selected = await ctx.bb.sdk.environments.get({ environmentId: matches[0]!.id });
  if (
    !reusable(selected, parent.projectId, repository.hostId) ||
    selected.path !== matches[0]!.path ||
    !(await selectable(ctx.bb, selected))
  )
    return unavailable(
      "This checkout needs a visible, unarchived thread in its ready BB environment before opening a new chat here.",
    );

  const current = await ctx.bb.sdk.threads.get({ threadId, include: "environment" });
  if (!sameParent(parent, current)) throw new Error(MOVED);
  return {
    state: "ready" as const,
    projectId: parent.projectId,
    hostId: repository.hostId,
    environmentId: selected.id,
    path: repository.path,
  };
}
