---
name: unity-editors
description: Claim, wait for, reserve and release Unity Editors for a BB thread, ask an owner for a handoff, and lease registered Rampage checkout slots.
---

# Unity Editor ownership

Claims coordinate participating tools only. Direct Unity CLI, UI and agent-game
calls cannot be intercepted, so check ownership first and never bypass another
thread's claim. Use `bb game-studio manage ACTION` or the `game_studio_manage`
tool; the calling BB thread is always the owner.

## Protocol

1. `bb game-studio manage list`. Pick the exact instance by `projectPath`,
   `pid`, `workspacePath`, owner and `clone` flag. Each checkout is listed as a
   slot with its main Editor, MPPM clients, claims and reservations.
2. Claim it: `claim --instance ID --mode runtime` for read-only inspection, or
   `--mode authoring` for Assets/Packages writes, imports, scene edits, Play and
   scenario lifecycle. Keep the returned `claimId`; the response carries
   `background.quiet`.
3. Drive the Editor with the Unity CLI, passing the claim's exact
   `instance.projectPath` as `--project-path` (an MPPM client's own clone path,
   never the shared `workspacePath`). Confirm the served PID equals
   `instance.pid` before a series of calls. If the PID, start identity or path
   changes, stop, `recover` the old claim and claim the new instance.
4. Before writes, `status --instance ID --claim CLAIM` and proceed only while
   `background.quiet` is true. Run long operations with `--detach`, record each
   job id with its project path, and `unity job wait JOB --project-path PATH`
   before release; ownership does not track CLI jobs, and a timeout or lost
   response proves nothing.
5. `release --instance ID --claim CLAIM` (or `--claim CLAIM` alone) once input,
   recorders and jobs are finished. Release refuses a busy Editor.

## Turn end

Claims and reservations release automatically when the owning thread's turn
ends, as soon as the Editor is quiet; a busy Editor shows
`autoRelease: "pending"` until then. Re-claim at the start of each turn. Pass
`--hold` only for an agreed preview handoff or work that continues next turn,
and say so in the handoff. A held claim survives idle turns and plugin reloads
and never expires.

## When the Editor is owned

The conflict names the owner, whether its thread is active or idle, and whether
the claim is held or about to release. Then choose one:

- `wait --instance ID --mode MODE --timeout 300` blocks until the Editor frees
  and claims it; it wakes on every release and fails with the same advice.
- `request --instance ID --mode MODE --reason "..."` sends the owner a handoff
  request for its next turn. Wait for its reply or ETA; one request per owner
  per minute.
- Open your own worktree Editor where the project's guide allows it.

Never bypass, restart or save another thread's Editor. If you receive a handoff
request: finish or wait for native work, preserve dirty scenes, release, then
reply with `bb thread tell REQUESTER --mode steer '...'`.

## Opening an Editor

Reserve the checkout first so the Editor is yours from its first discovery:
`reserve --workspace /abs/checkout --mode authoring`, then `unity open`, then
claim the discovered instance; the claim consumes the reservation. One
reservation exists per checkout. It releases at turn end unless held, and
`release --workspace PATH` drops it early.

## Modes and limits

Runtime claims coexist and allow only read-only CLI calls, including one agent
per MPPM client. Authoring excludes every other thread on the shared checkout;
clones cannot author. Physical focus, screen capture, simulated input and
backend accounts stay shared across checkouts: coordinate them with every owner
on the host. Linux startup Editors (`port:null`) take an authoring claim for
their startup dialog only; make no CLI calls until re-claiming the same instance
after Pipeline starts promotes the claim.

## Recovery

`recover --instance ID` removes a claim whose Editor process is gone. For a
live Editor whose owner thread is archived or deleted, add
`--confirm --note "observed completion evidence"` after checking owned input,
recorders and detached jobs; native work must be idle. Restoring the thread
restores its protection. `reconcile --instance ID --claim CLAIM --confirm
--note "..."` finishes pre-upgrade pending jobs only.

## Registered checkout slots

`game_studio_slots` and `bb game-studio slots` lease whole registered Rampage
checkouts to one thread. New threads select the `unity-rampage-slot`
environment provider with inputs `{}` for a free warm slot or
`{"slotId": "..."}` for an adopted checkout; the lease is acquired on dispatch
and kept across idle turns. Create warm slots once from a clean, stopped
registered master: `slots create --host HOST --source MASTER --path /abs/slot
--branch scott/NAME`, on the same copy-on-write filesystem with no full-copy
fallback. Release at handoff after Editor claims are released and Unity plus its
MPPM clients are closed; a failed check quarantines the slot until
`slots recover --slot ID --confirm --note "..."`. Without registered slots,
claims and reservations alone coordinate checkouts and worktrees.

CLI identity comes from `BB_THREAD_ID`; it is a coordination interface, not
access control. `list` hides other owners' claim ids, and the public
`listUnityEditors` RPC hides all of them.
