import type { BbPluginApi } from "@get-bb/plugin-sdk";
import path from "node:path";
import { checkoutResource, reviewCheckoutContract } from "./review-checkout-contract";

export function registerReviewCheckout(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: reviewCheckoutContract });
  bb.experimental_environments.register({
    id: "slopcop-review",
    displayName: "Slopcop PR worktree",
    description: "Review the pinned GitHub PR head, including deleted source branches.",
    icon: "GitBranch",
    requires: { projectCheckout: true, gitCheckout: true },
    inputs: reviewCheckoutContract.prepare.input.pick({ number: true, head: true }),
    async create(context) {
      const source = context.projectCheckout.path;
      const resource = {
        source,
        path: path.join(path.dirname(source), ".slopcop-reviews", context.pathKey),
        ref: `refs/slopcop/${context.thread.id}`,
      };
      if (!(await context.experimental_claimPath(resource.path))) {
        return { status: "failed", message: "Review worktree path is already owned" };
      }
      const prepared = await host.call(
        "prepare",
        { ...resource, ...context.inputs },
        {
          hostId: context.host.id,
          signal: context.signal,
          timeoutMs: 300_000,
        },
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
