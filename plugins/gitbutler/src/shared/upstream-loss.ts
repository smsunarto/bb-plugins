import type { Branch } from "./schema.ts";

/**
 * The upstream commits a push would delete: those of this branch and every
 * branch below it in its stack, since `but push` forces them all, where the
 * remote holds commits the branch has no copy of. The card counts them the
 * same way, so the two agree on what the reader was asked about.
 */
export function upstreamLoss(pushedWith: readonly Branch[]): string[] {
  return pushedWith
    .filter((entry) => entry.newUpstream > 0)
    .flatMap((entry) => entry.upstreamCommits.map((commit) => commit.commitId));
}
