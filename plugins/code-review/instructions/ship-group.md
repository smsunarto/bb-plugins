{{action}} the changes in this Review card, using the exact repositories, accounts, and branches below. Refresh each target first and report outcomes and blockers independently. Use the repository's shipping workflow for targets absent from mergeTargets; do not treat them as already approved for merging.

For each mergeTargets entry, merge that PR using the named account and a repository-allowed method only if its headRefOid and baseRefName still match. If either changed, stop that target and report that new review is needed. Recheck that it is open, not a draft, mergeable, the account can merge, GitHub mergeStateStatus is CLEAN or HAS_HOOKS, and reviewDecision is APPROVED or no review is required. Respect required checks, reviews, and merge queues; report blockers instead of bypassing them. Guard the merge against a concurrent push with the expected head (for example gh pr merge --match-head-commit). After merging, call code_review_share_landed with all work this thread delivered.

For local branches, base and head identify the shared comparison; review the new changes before shipping if either moved. A partially completed group remains incomplete.

{{targets}}
