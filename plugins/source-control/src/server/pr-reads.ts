/**
 * Pull requests by reference for other plugins (core/pr-reads.ts). Each
 * repository is one GitHub read, as the first account that can see it: the
 * bb server's, then the calling environment's host's. No other host is
 * asked. A repository that can't be read fails only its own refs. Nothing
 * is stored; the caller keeps what it needs.
 */
import { Effect } from "effect";
import { describeProblem, type Placement, type Problem } from "../core/change.ts";
import type { PrStatusRead } from "../core/pr-reads.ts";
import { prKey, type PrRef } from "../core/watch.ts";
import type { ForgeSites } from "./forge-sites.ts";
import type { Placements } from "./placement.ts";

/** Repositories read at once. */
const REPO_CONCURRENCY = 4;

/** One line for a repository that couldn't be read, with GitHub's detail when there is one. */
function problemLine(problem: Problem): string {
  if ((problem.kind === "auth" || problem.kind === "failed") && problem.detail)
    return problem.detail;
  return describeProblem(problem);
}

export function createPrReads(deps: {
  sites: Pick<ForgeSites, "repoRead">;
  placements: Pick<Placements, "forEnvironment">;
}) {
  /** Where the environment's checkout is, for its host's `gh`; none when it has no checkout. */
  const placementsOf = (environmentId: string | null) =>
    environmentId === null
      ? Effect.succeed<Placement[]>([])
      : deps.placements.forEnvironment(environmentId).pipe(
          Effect.map((where) => (where.state === "checkout" ? [where.placement] : [])),
          Effect.orElseSucceed(() => []),
        );

  return Effect.fn("prStatuses")(function* (environmentId: string | null, refs: readonly PrRef[]) {
    const placements = yield* placementsOf(environmentId);
    const byRepo = new Map<string, { repo: { owner: string; name: string }; refs: PrRef[] }>();
    for (const ref of refs) {
      const id = `${ref.owner}/${ref.repo}`.toLowerCase();
      const group = byRepo.get(id) ?? { repo: { owner: ref.owner, name: ref.repo }, refs: [] };
      if (!group.refs.some((each) => each.number === ref.number)) group.refs.push(ref);
      byRepo.set(id, group);
    }
    const answers: Record<string, PrStatusRead> = {};
    yield* Effect.forEach(
      [...byRepo.values()],
      (group) =>
        deps.sites
          .repoRead(
            { kind: "prStatuses", repo: group.repo, numbers: group.refs.map((ref) => ref.number) },
            placements,
          )
          .pipe(
            Effect.map((answer) => {
              const found = new Map(
                answer.kind === "prStatuses"
                  ? answer.statuses.map((each) => [each.number, each.status])
                  : [],
              );
              for (const ref of group.refs) {
                const status = found.get(ref.number);
                answers[prKey(ref)] = status
                  ? { ok: true, value: status }
                  : {
                      ok: false,
                      reason: "not-found",
                      message: `${prKey(ref)} is not a pull request GitHub knows.`,
                    };
              }
            }),
            Effect.catchTag("ForgeUnavailable", (error) =>
              Effect.sync(() => {
                const message = problemLine(error.problem);
                for (const ref of group.refs)
                  answers[prKey(ref)] = { ok: false, reason: "unavailable", message };
              }),
            ),
          ),
      { concurrency: REPO_CONCURRENCY, discard: true },
    );
    return answers;
  });
}

export type PrReads = ReturnType<typeof createPrReads>;
