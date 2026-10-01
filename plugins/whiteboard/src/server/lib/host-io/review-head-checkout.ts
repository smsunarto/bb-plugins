import { HOST_TIMEOUT_MS } from "../../../shared/contracts/host-contract.ts";
import type * as upstream from "../../../shared/node/vendor/review/src/review-head-checkout.ts";
import { invokeOn, rememberPath } from "./client.ts";

/**
 * Server facade for `review-head-checkout` (design §3.1). The managed
 * checkout lives on the repository's host; its path is remembered so the
 * structural diff that follows runs there too.
 */
export const ensureReviewPinnedCheckout: typeof upstream.ensureReviewPinnedCheckout = async (
  input,
) => {
  const { value, hostId } = await invokeOn(
    "review-head-checkout",
    "ensureReviewPinnedCheckout",
    [input],
    { rootPath: input.rootPath },
    { timeoutMs: HOST_TIMEOUT_MS.long },
  );
  rememberPath(value as string | null, hostId);
  return value as string | null;
};
