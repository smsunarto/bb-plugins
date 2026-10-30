import type * as upstreamTypes from "../../../shared/node/review/review-branch-links.ts";
import { resolveReviewBranchLinks as resolveHere } from "../../../shared/node/review/review-branch-links.ts";
import { invokeHost } from "./client.ts";

/** Server facade for `review-branch-links` (design §3.1). */
export type { ReviewBranchLinks } from "../../../shared/node/review/review-branch-links.ts";

/**
 * With the default git runner, the lookup runs on the checkout's host. An
 * injected runner runs here, as upstream.
 */
export const resolveReviewBranchLinks: typeof upstreamTypes.resolveReviewBranchLinks = async (
  input,
  runGit,
) => {
  if (runGit) return resolveHere(input, runGit);
  return (await invokeHost("review-branch-links", "resolveReviewBranchLinks", [input], {
    rootPath: input.rootPath,
  })) as Awaited<ReturnType<typeof upstreamTypes.resolveReviewBranchLinks>>;
};
