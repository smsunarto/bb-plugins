import type { ReviewStackLayer } from "../../../shared/review-protocol/index.ts";
import * as upstream from "../../../shared/node/review/review-stack.ts";
import { type HostRoute, invokeHost } from "./client.ts";

/** Server facade for `review-stack` (design §3.1). `gh api` runs on the host. */
export type {
  ReviewStackCandidate,
  ReviewStackSubject,
  RunGitHubApi,
} from "../../../shared/node/review/review-stack.ts";

/**
 * With the default runner, the whole lookup runs on the host `route` names:
 * the session repository's host, whose `gh` knows the user's GitHub. Upstream
 * answers `[]` whenever GitHub cannot be asked, so a host that cannot be
 * reached or chosen answers `[]` too. An injected runner runs here, as
 * upstream.
 */
export async function resolveReviewStackLayers(
  subject: upstream.ReviewStackSubject,
  reviews: readonly upstream.ReviewStackCandidate[],
  runGitHubApi?: upstream.RunGitHubApi,
  route: HostRoute = {},
): Promise<ReviewStackLayer[]> {
  if (runGitHubApi) return upstream.resolveReviewStackLayers(subject, reviews, runGitHubApi);
  // Same early exit as upstream: no PR binding asks nobody.
  if (!subject.pullRequestUrl) return [];
  try {
    return (await invokeHost(
      "review-stack",
      "resolveReviewStackLayers",
      [subject, reviews],
      route,
    )) as ReviewStackLayer[];
  } catch {
    return [];
  }
}
