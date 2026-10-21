Read a shared engineering principle with `bb dev-mode principle --name <name>`, or omit `--name` to list names.

Arena and review each ask one Claude and one Codex child thread the same prompt. Dev Mode authorizes starting them. Write the prompt to a file outside the checkout, for example with `mktemp`, then run this once with `claude-code` and once with `codex`:

```sh
bb thread spawn --parent-self --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" --provider <provider> --reasoning-level high --title "<title the skill names>" --prompt-file <file> --json
```

The children see only that prompt and this checkout, so make it self-contained. End it with "Do not edit files, commit, or start other threads." BB messages this thread as each child finishes; read one with `bb thread output <thread-id>`. If one launch fails, keep the other and report it. Wait on a child with `bb thread wait <thread-id> --timeout 9m`, and deny any permission request it raises with `bb thread interactions deny <interaction-id> <thread-id>`. A child that stays stuck is missing; say so.

Use Arena (the `arena` skill) when the user asks for it. Review a change with the `review` skill at implementation handoff, after relevant checks and a commit, and review a consequential design before implementing it. Honor an explicit skip.
