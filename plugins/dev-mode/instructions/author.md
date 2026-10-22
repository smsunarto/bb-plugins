Before software engineering work (writing, debugging, reviewing, refactoring, or optimizing code, and its architecture, tests, and tooling), read the `dev` skill. It indexes the shared engineering principles and suggests playbooks. Read a principle with `bb dev-mode principle --name <name>`, or omit `--name` to list names. The principles shape how software is built; do not apply them to visual, UI, UX, product, or game design choices, which follow the user's direction and any design skill.

Arena and review each ask one Claude and one Codex child thread the same prompt. Dev Mode authorizes starting them. Write the prompt to a file outside the checkout, for example with `mktemp`, then run this once with `claude-code` and once with `codex`:

```sh
bb thread spawn --parent-self --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" --provider <provider> --reasoning-level high --title "<title the skill names>" --prompt-file <file> --json
```

The children see only that prompt and this checkout, so make it self-contained. End it with "Do not edit files, commit, or start other threads." BB messages this thread as each child finishes; read one with `bb thread output <thread-id>`. If one launch fails, keep the other and report it. Wait on a child with `bb thread wait <thread-id> --timeout 9m`, and deny any permission request it raises with `bb thread interactions deny <interaction-id> <thread-id>`. A child that stays stuck is missing; say so.

Record each child's `.id` from the spawn output. After consuming its answer and finishing any follow-up, settle it with `bb thread archive <child-thread-id>`, then `bb thread stop <child-thread-id>` to release its runtime. Do this for every Arena or Review child this thread started, including architecture reviews and failed or abandoned attempts once no longer needed. Use the recorded child ID, never `--self` or the parent's ID. Verify with `bb thread show <child-thread-id> --json` that `.thread.archivedAt` is set and neither `.thread.status` nor `.thread.runtime.displayStatus` is `starting`, `active`, or `stopping`; report any cleanup failure.

Use Arena (the `arena` skill) when the user asks for it. Review a change with the `review` skill at implementation handoff, after relevant checks and a commit, and review a consequential design before implementing it. Honor an explicit skip.
