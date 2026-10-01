import { HOST_TIMEOUT_MS } from "../../../shared/contracts/host-contract.ts";
import type { ReviewStackLayer } from "../../../shared/vendor/review-protocol/src/index.ts";
import * as upstream from "../../../shared/node/vendor/review/src/review-stack.ts";
import { invokeHost } from "./client.ts";

/** Server facade for `review-stack` (design §3.1). `gh api` runs on the host. */
export type {
  ReviewStackCandidate,
  ReviewStackSubject,
  RunGitHubApi,
} from "../../../shared/node/vendor/review/src/review-stack.ts";

/**
 * With the default runner, the whole lookup runs on the caller's host (a
 * stack names no checkout). Upstream answers `[]` whenever GitHub cannot be
 * asked, so a host that cannot be reached or chosen answers `[]` too. An
 * injected runner runs here, as upstream.
 */
export const resolveReviewStackLayers: typeof upstream.resolveReviewStackLayers = async (
  subject,
  reviews,
  runGitHubApi,
) => {
  if (runGitHubApi) return upstream.resolveReviewStackLayers(subject, reviews, runGitHubApi);
  // Same early exit as upstream: no PR binding asks nobody.
  if (!subject.pullRequestUrl) return [];
  try {
    return (await invokeHost(
      "review-stack",
      "resolveReviewStackLayers",
      [subject, reviews],
      {},
      { timeoutMs: HOST_TIMEOUT_MS.long },
    )) as ReviewStackLayer[];
  } catch {
    return [];
  }
};
