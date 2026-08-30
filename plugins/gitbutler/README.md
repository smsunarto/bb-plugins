# GitButler for BB

Open **GitButler** from a repository-backed thread's panel. The panel preserves every applied stack, branch, commit, changed file, and current worktree hunk.

Select the exact hunks to commit, enter a message, then choose an existing branch or an explicit new branch. The host rereads GitButler state before one commit attempt. A stale selection never runs a commit, and an ambiguous result is reported as uncertain instead of retried.

The first release supports `but 0.22.3` exactly. Unsupported versions fail closed until their JSON and selector behavior have fixtures.
