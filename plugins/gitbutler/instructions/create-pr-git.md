Open a pull request for the checked-out branch in this ordinary Git checkout. GitButler does not manage this checkout; use native Git and the forge CLI here, and never run `but setup`. Run these from the repository, exactly as quoted:

{{show}}

1. Verify that this is still the checked-out branch. Read its changes and the repository's PR template. If the checkout moved to another branch or a merge/rebase is in progress, stop and report that change.
2. Resolve the publication destination before writing. Read each configuration value below independently; an unset key is normal. In the `for-each-ref` output, use only the exact local branch ref, not a longer branch whose name starts the same way.

{{configuration}}

Choose the push remote in this order: this branch's `pushRemote`, `remote.pushDefault`, `gitbutler.project.pushremote`, this branch's `remote` unless it is `.`, then a verified remote named `origin`, or the sole configured remote. If no choice is unambiguous, stop and report the configuration. Verify that the selected remote exists and inspect its push URL. Do not assume the remote is named `origin`.

If the branch has an upstream, its remote must match the selected push remote. Its `merge` setting supplies the destination ref, which must be one `refs/heads/...` ref; preserve that published name even when it differs from the local branch name or its remote-tracking ref has not been fetched. For example, local `scott/feature` tracking `origin/review-feature` must publish to `refs/heads/review-feature`, and the PR head is `review-feature`. Stop if the upstream is local, has multiple merge refs, or cannot be reconciled with the selected remote. Only a branch without an upstream defaults its destination to its local branch name. Do not change this configuration.

3. Write a concise PR title and description explaining the resulting behavior and relevant verification. Put the description in a temporary file.
4. Push only the checked-out local branch to the resolved destination with `git push -- <remote> <source-ref>:<destination-ref>`, replacing all placeholders with the verified values and shell-quoting each argument. Both refs must be explicit `refs/heads/...` refs. Never force push, set an upstream, or push any other ref. If it is rejected, report the error and stop.
5. Resolve the forge repository and PR head from the verified publication destination. Use the published branch name, never an assumed copy of the local name. For a fork, use the correct fork owner and published branch in `--head` and the verified target repository in `--repo`. Use the configured target or that repository's actual default branch as the base; do not change the remote default. Find an existing open PR for that exact head and base repository and return its URL. Otherwise create it with the resolved `--repo` and `--head`, the title, and `--body-file` for the description. Return the PR URL.

Do not commit, amend, rename, switch, delete, or otherwise rewrite any branch. Do not run GitButler commands in this checkout. If the forge CLI is unavailable or cannot authenticate, report the error and stop.
