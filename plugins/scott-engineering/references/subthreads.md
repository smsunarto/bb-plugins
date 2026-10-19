# Fan out with BB subthreads

Arena, swarm, architect, and reflect run each parallel run as a linked BB child thread. Invoking one of these skills is the user's request to spawn those threads. Outside BB (`BB_THREAD_ID` unset), use the harness's own subagents with the same models and prompts.

## Models

| Model  | Spawn flags                                                                        |
| ------ | ---------------------------------------------------------------------------------- |
| Claude | `--provider claude-code --model claude-opus-5-5 --reasoning-level xhigh`           |
| Codex  | `--provider codex --model gpt-6.1-sol --reasoning-level xhigh --service-tier fast` |

These are model choices, not roles. When a skill compares models (arena candidates, architect sketches, a swarm race), give each model the identical prompt. The signal is how different models answer the same question, so do not assign them different personas or angles. A skill whose prompts differ by design, such as reflect's three lenses, names the model for each prompt.

A lone judge runs on the model the parent is not on (`bb thread show --self --json` shows the parent's provider). Raise reasoning to `max` for the hardest work and lower it to `high` or `medium` for routine work, but keep the model so a comparison stays between families. If a spawn rejects a model, use that provider's default from `bb provider models <provider>` and say so.

## Spawn

```sh
bb thread spawn --parent-self --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" \
  --title "<skill>: <run>" <model flags> --prompt-file <run-dir>/<run>.md --json
```

- `bb status --json` has the same IDs if the variables are unset (`.project.id`, `.thread.environment.display.id`).
- Pass every execution flag. Omitted flags fall back to the parent's live execution or project defaults, not the model the skill names.
- Write each prompt to a file under the run directory, spawn every child before ending the turn, and keep each returned `.id`.
- Share the parent's checkout for read-only children and children that write only to their own output directory. A child that checks out a commit is not read-only: it moves HEAD under the parent and its siblings.
- Give a child that edits the repository or checks out a commit a fresh worktree. A new worktree lacks untracked files. Read AGENTS.md first:
  - If it forbids worktrees because the host depends on one canonical checkout (dotfiles: home files are symlinks into it), keep repository edits in that checkout under one owning child at a time. Give the other children scratch directories for proposals and artifacts only. A child that only checks out commits to read or measure them can use a scratch clone (`git clone --shared <checkout> /tmp/<run>/<child>`).
  - If it forbids worktrees for another reason, give each such child a scratch clone and point its prompt there.
- BB rejects `--environment` combined with `--new-environment` or `--machine`, because an existing environment already fixes the checkout and machine. Replace the selector instead:
  - Fresh worktree: `--new-environment worktree`, plus `--base-branch <ref>` to start from a specific ref.
  - Another machine, only when the work needs it: `--machine <id> --new-environment worktree`, or `--machine <id> --environment <absolute-path>` for a checkout already on that machine.
- BB has no read-only flag. For a read-only child, say in its prompt: "Do not edit files, commit, or spawn threads."

## Every child prompt includes

- The goal, the inputs as absolute paths rather than inlined content, the child's own output path, how to verify, and what to return.
- This contract: "You are a subagent of thread `<parent-id>`. Do the work yourself and do not spawn threads. Act only within this prompt's authorization. Do not commit or push unless this prompt names you the owner. Your final reply reaches the coordinator automatically. Lead it with the outcome and your output path."

## Collect

- After spawning, do any independent work, then end the turn with one line linking the children. BB wakes this thread as each child finishes, fails, or needs attention. Do not loop on `bb thread wait`, sleeps, or status checks.
- On a needs-attention notice, run `bb thread interactions list <id>` and settle it within the user's existing authorization.
- Once every child has reported, read `bb thread output <id>` for each, because notices can be abbreviated, and check that the promised artifact exists. `idle` or `completed` is not success.
- Retry a transient failure with `bb thread retry <id>`. A child with no output after a retry is a dropout. Proceed with the rest and note it.
- Give new work, including a fix round, a retry with a changed brief, or a follow-up, to a fresh child. Its prompt carries the original brief, every later directive, and the prior child's output. Message an existing child only when the work needs state that lives there (its checkout, uncommitted changes, or a running process), or to stop or hold it. Use `bb thread tell <id> --mode steer --message-file -` for those messages, and `bb thread stop <id>` for a canceled child.
