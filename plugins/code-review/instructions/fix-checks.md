Fix the failing checks on pull request {{owner}}/{{repo}}#{{number}}: {{title}}

{{url}}

The pull request's branch is {{branch}}, at `{{headRefOid}}`. If this checkout is already on that branch at that commit, work there. Otherwise, fetch the pull request's head and create a local branch for the fix from it. Run these from the repository, exactly as quoted:

{{checkout}}

If a branch named {{fixBranch}} already exists, do not reuse or reset it: add a suffix such as `-2` to the new branch's name.

## Failing checks

{{checks}}

## Fix them

1. Read the applicable `AGENTS.md` instructions.
2. For each check, find the root cause of the failure from its log and the code. When a log is missing or cut short, open the check's URL with `gh` or run the check's command locally to see the failure.
3. Fix the code, not the check: do not skip, disable, or loosen a test or lint rule to make it pass, unless the check itself is wrong. If it is, say why.
4. Run each failing check's command locally and confirm it passes.
5. Commit the fix on that local branch with a message that says what was broken.

Do not push, and do not comment on the pull request. Reply with what failed, why, what you changed, how you verified it, and the local branch and commit, so the person who asked can review it and push it to the pull request's branch, {{branch}}.
