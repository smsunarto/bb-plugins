---
name: project-scripts
description: Generate and save repository commands as BB project scripts in the thread-details card. Use when asked to set up runnable project scripts for a repo.
---

# Project scripts

Inspect the repository, choose useful existing commands, and save them in Kitchen Sink's thread-details card. These scripts are shared by every thread in the BB project and run in a terminal at each thread's checkout root.

## Find the commands

Run `bb status --json` for the current `project.id` and `thread.environment.hostId`; it does not return a checkout path. For another repo, use `bb project list --json` to match the requested name or Git remote and select its project ID. Resolve ambiguous matches before saving.

Run `bb project show <project-id> --json` and select a `sources[].path` whose `hostId` matches the thread's checkout host. Verify that path exists on the machine where you inspect files. When already in a checkout of that project, use its actual working directory, including a worktree, to inspect the repo. If the checkout is on another host, use that host's available connection tools or report that it is unreachable; a remote path is not a local checkout. Use the selected project's ID for every script RPC.

Read the repo's agent instructions, README, task manifests, and lockfiles. Prefer its existing entrypoints (`package.json` scripts, mise tasks, Make targets, or equivalent), using the package manager and runtime the repo declares. Follow the command to its configuration when its purpose or working directory is unclear.

For a specific request, create the requested script. Otherwise choose a small set of useful development commands, with the main dev/run command first. Add test, lint, or build scripts when they are useful for this repo; an available task alone does not make it worth a card entry.

Use short action names such as `Dev server` or `Run tests`. Commands start at the checkout root: use relative paths, and prefix a subdirectory command with `cd <quoted-relative-path> && ...`. Keep machine-specific absolute paths and credentials out of saved commands. Repo-defined commands should work across the project's supported checkout hosts; describe any platform or prerequisite limits.

## Save in BB

Use the existing discoverable RPC; no repo config file or new wrapper is needed just to populate the card. Inspect its current contract if a call rejects the input:

```sh
bb plugin rpc inspect kitchen-sink projectScripts
bb plugin rpc inspect kitchen-sink saveProjectScript
```

Write JSON inputs to temporary files. List existing scripts first:

```json
{"projectId":"<resolved-project-id>"}
```

```sh
bb plugin rpc call kitchen-sink projectScripts --input-file <list-input.json> --json
```

Keep existing scripts. Reuse an existing ID when updating the same intended script; keep an unchanged matching command instead of adding a duplicate. Give each new script a stable ID of at most 64 characters, a name of at most 80, and a command of at most 4000. A project holds at most 20 scripts. If full, report the limit and propose which existing entry to replace.

Save one edit at a time:

```json
{"projectId":"<resolved-project-id>","edit":{"kind":"upsert","script":{"id":"<script-id>","name":"Dev server","command":"<verified-repo-command>"}}}
```

```sh
bb plugin rpc call kitchen-sink saveProjectScript --input-file <save-input.json> --json
```

Read the list again and confirm every intended ID, name, and command was persisted. If a save's outcome is uncertain, read before retrying with the same ID. Remove this run's temporary input files.

## Verify and report

Confirm that each command resolves to a real repo entrypoint and note its prerequisites. Saving a script does not require launching it: run it only when requested or needed for the task's verification, and clean up processes you start. Separate commands actually tested from commands checked through repo configuration.

Report the target project, saved script names and commands, and any untested prerequisites. If the plugin is unavailable or saving fails, provide the prepared scripts and state that they were not saved.
