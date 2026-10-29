---
name: boat-sandbox
description: Create, inspect, stop or remove bb machines that run in Boat cloud sandboxes, or diagnose a Boat machine that will not start or resume.
---

# Boat machines

1. `bb boat account inspect --json` tests the configured key without allocating
   compute. Exit status 1 means the plugin needs an `apiKey` in its settings or
   Boat rejected the key; the JSON carries a secret-free message.
2. `bb boat launch options --json` lists the sizes this account can create now
   and its ready saved snapshots.
3. Create a standalone machine with
   `bb machine create --provider boat-sandbox --json`, optionally with
   `--machine-inputs '{"type":"large","from":"web-stack"}'`. A new thread with
   its own sandbox uses
   `bb thread spawn --project <id> --environment-provider boat-sandbox --prompt "..."`;
   do not pass machine selectors with that environment. Creation, checkout
   setup and the daemon install report into the launch log.
4. `bb boat machine inspect HOST_ID --json` reads Boat's state for a machine:
   `state` (starting, running, stopping, stopped, error, missing),
   `archiveAfter` (Boat's auto-stop deadline in epoch milliseconds, null when
   off), `hydrated`, `dataExpired`, and `error` (Boat's reason when the state
   is error). A `missing` result carries only `state`, `sandboxId`, and
   `summary`.

Boat sandboxes cost money while they run. Create or resume one only when the
task calls for it, and stop or remove it when the task ends.

## What each state means

- `stopped`: Boat saved the disk and removed the machine. Resume restores it on
  a new machine with the same sandbox id; bb reinstalls its daemon and keeps
  the checkout. Processes you started by hand are gone.
- `error`: the machine was lost. Resume uses the newest background snapshot,
  up to a minute old; mention that to the user.
- `dataExpired: true`: the sandbox stayed stopped for 14 days and Boat deleted
  its disk. It cannot resume; remove the machine with
  `bb machine remove MACHINE --yes`.
- `missing`: the sandbox was deleted outside bb. Remove the machine.

The plugin stops an idle machine after `idleMinutes` (default 15) and extends
Boat's auto-stop while the machine is active. A machine that Boat stopped on
its own (auto-stop, empty wallet) is reconciled within a minute and resumes on
the next thread message.

## When a launch fails

- `rate_limited` or `limit_reached`: a Boat start limit. Wait for the named
  window, or stop another sandbox, then retry.
- `billing_required`: the account has no plan or an empty wallet. The user has
  to pay in the Boat dashboard.
- `trial_auto_stop_required`: the free trial refuses `autoStopHours` of 0 or
  above 2. Lower the setting.
- `api_key_action_forbidden` or `api_key_sandbox_forbidden`: the key's scope is
  too narrow. Create a new `ci` key.
- "Restore the machine's pinned Boat account": the configured key belongs to a
  different Boat account than the one that created the machine.
