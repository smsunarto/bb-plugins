Delegation presets are user-defined; Tasks ships with none. Before dispatching
work, use `bb tasks preset list` and create a preset if the required one does
not already exist. Dispatch requires an existing preset.

Create or update the same execution selection exposed in the Tasks UI with
`--provider`, `--model`, `--reasoning`, and optional
`--service-tier <tier>`. Reasoning levels and tiers are ids the provider lists
for the model (a tier is `default`, `fast`, or another such as Codex
`ultrafast`; see `bb provider models <provider> --json`):

```sh
bb tasks preset create --name "Codex high" --provider codex \
  --model gpt-5.6-sol --reasoning high --service-tier fast \
  --permission auto
```

`preset update` accepts the same flags; `--clear-service-tier` clears a tier.
Do not combine it with `--service-tier`; `none` is a literal tier id.

## Dispatch as a child thread

An orchestrating agent that dispatches its own crew passes itself as the
parent, so bb reports the crew's turns back to it:

```sh
bb tasks delegate ABC-12 --preset "Codex high" \
  --parent-thread "$BB_THREAD_ID" --parent-notifications stuck \
  --base-branch scott/feature
```

- `--parent-thread <thread-id>` spawns the thread as that thread's child.
- `--parent-notifications auto|stuck|off` picks which child turns bb reports:
  every turn, only when the child needs help, or none. bb defaults to `auto`.
  It requires `--parent-thread`.
- `--base-branch <branch>` starts a new worktree from that branch for this
  dispatch only, whatever environment the preset names. The preset is
  unchanged.
