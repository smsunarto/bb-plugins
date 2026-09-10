---
name: test-remotely
description: Test the current work on a remote BB machine and return reviewed screenshots or a recorded demo. Use for remote verification of project changes, including /test-remotely.
---

Coordinate remote verification through `/subthread`. The remote child does setup,
testing, and capture. Start it with Codex `gpt-6-astra`, reasoning `low`. Prefer
fixes and retests in that same child at reasoning `high`, preserving its context.

1. Run `python3 <skill-dir>/scripts/remote_test.py inventory`. Prefer
   `codex@cardinal`, the large Ubuntu Exe.dev VM. Use `Dev Mac` only for macOS
   requirements or sustained Cardinal overload. Among eligible hosts, compare
   measured load and reserved CPU/memory relative to capacity. Two Cardinal
   accounts share one physical machine. Run all managed Cardinal tests as `codex`.
   Coordinate with active `exedev` work before reserving capacity or shared setup.
   An auth failure is not overload:
   authenticate with 1Password or ask the user before changing machines.
2. Commit the task's changes on its feature branch with GitButler. Keep other
   agents' work out. Write a task file with behavior, checks, platform, and expected
   evidence. The helper pushes the branch with GitButler, pins its commit and
   comparison base, then launches the remote `/subthread`. Run it outside the
   sandbox when GitButler requires that.

   Pushing needs no approval. Use a feature branch. Push `origin/main` only when
   unavoidable **and** the GitHub repository belongs to `smsunarto`; document why
   with `--main-reason`. This does not authorize merging or opening a PR.

   ```sh
   python3 <skill-dir>/scripts/remote_test.py launch --repo . --branch scott/<task> --base origin/main --task <task.md> --out <new-run-directory> --machine codex@cardinal
   ```

   Git is the source of truth. Include intended edits and new files in the commit.
   Uncommitted and ignored files are not transferred. The worker receives full
   history and reviews the commit log and diff before testing. For `Dev Mac`,
   supply `--mac-reason mac-required|cardinal-overloaded` and explain the evidence.

3. Read [worker.md](references/worker.md) for the worker contract. Require explicit
   use of **`dotfiles:sync`** to sync and apply `~/git/dotfiles`, then scaffold missing
   project prerequisites. Setup touching shared tools/configuration is exclusive.
   Concurrent tests need separate directories, ports, profiles, data, and resource
   reservations. Queue conflicting or oversized work instead of disturbing it.
4. Give the remote child ownership of the feature branch while testing and fixing.
   Do not edit/push that branch here or assign another writer concurrently.
   When the testing turn reports a failure, resume **the same child** with:

   ```sh
   python3 <skill-dir>/scripts/remote_test.py revise --thread <child-id> --task <fix-request.md>
   ```

   This starts Codex Astra **High**. The worker fixes, commits, pushes, and retests
   in its existing checkout. Coordinate scope changes instead of syncing each fix
   back and forth. After receiving the final evidence, run the helper's
   `sync-result --repo . --source <returned-source.json>` to preview the final
   GitButler update. If clean and scoped to this branch, repeat with `--apply`.
   It stops if relevant local work or the remote tip moved.

5. Coordinate with `bb thread tell <id> "<message>"`, inspect with
   `bb thread show <id> --json`, and read results with `bb thread output <id>`.
   Collect the worker's artifact manifest using the helper's `receive` command.
   Review the actual evidence and show screenshots inline. Use **`media:demo`**
   for recording, review, and BB inline video delivery. Report tested commit,
   machine, checks, failures, and evidence. Idle is not proof of success.
