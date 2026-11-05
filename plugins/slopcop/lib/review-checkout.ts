import type { BbPluginApi } from "@get-bb/plugin-sdk";
import path from "node:path";
import { checkoutResource, reviewCheckoutContract, reviewTarget } from "./review-checkout-contract";

export function registerReviewCheckout(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: reviewCheckoutContract });
  bb.experimental_environments.register({
    id: "slopcop-review",
    displayName: "Slopcop PR worktree",
    description: "Review the pinned GitHub PR head, including deleted source branches.",
    icon: "GitBranch",
    // gitRemote, not projectCheckout: on a new machine projectCheckout makes core
    // clone the full repository before create runs, even when the machine image
    // already holds a clone. The host finds or partially clones one instead.
    requires: { gitRemote: true },
    inputs: reviewTarget,
    async create(context) {
      const call = { hostId: context.host.id, signal: context.signal };
      context.report.step("Finding a clone of the repository");
      const { source } = await host.call(
        "resolveSource",
        { remote: context.gitRemote, preferred: context.projectCheckout?.path ?? null },
        { ...call, timeoutMs: 600_000 },
      );
      const resource = {
        source,
        path: path.join(path.dirname(source), ".slopcop-reviews", context.pathKey),
        ref: `refs/slopcop/${context.thread.id}`,
      };
      if (!(await context.experimental_claimPath(resource.path))) {
        return { status: "failed", message: "Review worktree path is already owned" };
      }
      context.report.step("Checking out the PR head");
      const prepared = await host.call(
        "prepare",
        { ...resource, ...context.inputs },
        { ...call, timeoutMs: 300_000 },
      );
      return {
        status: "created",
        path: prepared.path,
        ownsPath: true,
        resource,
        mergeBaseBranch: context.inputs.head,
      };
    },
    async remove(context) {
      if (!context.hostId || !context.resource) return { status: "removed" };
      await host.call("remove", checkoutResource.parse(context.resource), {
        hostId: context.hostId,
        signal: context.signal,
        timeoutMs: 150_000,
      });
      return { status: "removed" };
    },
  });
}
