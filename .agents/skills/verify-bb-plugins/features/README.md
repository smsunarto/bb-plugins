# bb-plugins verification map

This directory is the maintained source for verifying bb-plugins features in this thread's test instance. Read this index before driving the app, then follow the file for each feature the change touches.

## Baseline preconditions

- The test instance is up, and `scripts/doctor.ts --plugin <id>` exits 0 for every plugin under test. [SKILL.md](../SKILL.md) defines `INST`, `TB`, `URL`, `RUN`, and `EV`.
- The instance mirrors live's enabled plugins, plugin settings, keybindings, and theme. It starts with no projects or threads.
- Browser session `$RUN` was opened with `set viewport 1920 1080 2` and `set media dark` before its first `open`.
- The [bb Monokai](bb-monokai.md) baseline probe reports Dark and the Monokai palette.

## Driving conventions

- Start each recipe from `"$URL"` after `wait --text "New thread"` unless its preconditions say otherwise.
- Prefer roles and accessible names. Use a CSS selector only where a feature file names it as a stable handle.
- Treat every command as literal. Substitute only `$RUN`, `$URL`, `$TB`, `$EV`, and ids a recipe tells you to record.
- Create fixtures through `"$TB"` with names starting `verify-`. Keep fixture repositories under `$BB_THREAD_STORAGE/verify/$RUN-fixtures`, outside `$EV`.
- Restore every setting a recipe changes to its mirrored live value.

## Proof and skip reporting

- Capture the state before the action and the resulting state, not only the final screen.
- Prove each stored change through a second view: `"$TB" … --json` or the surface after a reload.
- Record the feature, sub-feature ID, and entry point with every artifact in `$EV/result.md`.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report it verified through a different entry point.

## Feature entry contract

Each feature file starts with an H1 and one paragraph describing the user-visible behavior, then uses exactly four H2 sections in this order:

1. `Sub-features` lists short IDs, one line each.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with agent-browser` starts with `Preconditions:`, then labeled bullets that pair each user action with an exact command and its observable result.
4. `Gotchas` lists traps that can waste or invalidate a run.

Keep implementation detail out. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

One file per plugin under `plugins/`, except Kitchen Sink, which has one file per feature. Steps still marked `<!-- unverified -->` name the precondition the verifying run lacked, such as a paid turn, GitHub, a Mac, or a real device.

Appearance and navigation:

- [bb Monokai](bb-monokai.md) (`monokai`) covers the palette, Dark rendering, and the UI font setting. Its probe is every run's visual baseline.
- [GTD Sidebar](gtd-sidebar.md) (`gtd-sidebar`) covers the shelf inbox, project groups, snooze, settle, and thread titles.
- [Vimium](vimium.md) (`vimium`) covers link hints, direct keys, and the cheatsheet.
- [Usage Bar](usage-bar.md) (`usage-bar`) covers the macOS menu bar items for Codex and Claude usage.

Threads and composer:

- [T3 Composer](t3-composer.md) (`t3-composer`) covers the restyled composer and its controls.
- [GenUI](genui.md) (`genui`) covers ` ```ui ` and ` ```app ` blocks in replies, the Gallery, and the agent tools.
- [Installed Plugin Mentions](at-plugin.md) (`at-plugin`) covers `#` plugin mentions in the composer.
- [Agentation](agentation.md) (`agentation`) covers UI annotations and their delivery to agents.
- [Kitchen Sink: thread details](kitchen-sink-thread-details.md) covers the thread context card rows and project scripts.
- [Kitchen Sink: thread motion](kitchen-sink-thread-motion.md) covers timeline motion and Jump to latest.
- [Kitchen Sink: completion sound](kitchen-sink-completion-sound.md) covers the chime when a turn finishes.
- [Kitchen Sink: RPIV task list](kitchen-sink-rpiv-todo.md) covers the task banner and its setting.
- [Kitchen Sink: skills](kitchen-sink-skills.md) covers the `/project-scripts`, `/subthread`, and `/test-remotely` composer skills and the Clicky macOS companion.
- [Kitchen Sink: phone touches](kitchen-sink-mobile.md) covers haptics and compact-layout fixes.

Code and review:

- [Source Control](source-control.md) (`source-control`) covers the branch and PR cards, the review panel, and its guide.
- [Traces](traces.md) (`traces`) covers the Claude Code and Codex session explorer.

Agents, providers, and automation:

- [Agent Instructions](agent-instructions.md) (`agent-instructions`) covers the instruction and skill catalog.
- [Captain](captain.md) (`captain`) covers Captain threads and their crews.
- [Devin](devin.md) (`devin`) covers the Devin provider and its Cloud handoff.
- [Tasks](scott-tasks.md) (`scott-tasks`) covers the task board and list.
- [SlopCop](slopcop.md) (`slopcop`) covers GitHub issue and PR rules.
- [Sauce Live](sauce.md) (`sauce`) covers real-device sessions.
- [Secrets](scott-secrets.md) (`scott-secrets`) covers credential requests and sudo.
- [Dotfiles](dotfiles.md) (`dotfiles`) covers the dotfiles source and tracked programs. It stays disabled on the test instance until its repository setting points at a disposable copy.

`plugins/scott-docs` holds only untracked build output; the plugin was removed and has no file.
