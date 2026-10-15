---
name: unity-editors
description: Discover Unity Editor checkout slots, claim an exact instance for a BB thread, run guarded commands, and release ownership.
---

# Unity Editor ownership and checkout slots

Use `bb unity manage list` or the `unity_manage` agent tool.
The inventory includes `slots`, grouped by the host's canonical shared Assets
checkout (`workspacePath`), with a stable host-scoped id, main Editors, MPPM
Editors, and durable claims. A slot is an existing checkout, not a Git branch.
A claim remains visible when its Editor disappears from discovery until it is
safely recovered. Listing does not provision checkouts or launch Editors.

Choose separate physical checkouts or worktrees for concurrent authoring.
Each checkout needs its own Assets, Packages and Library. MPPM clones share
Assets with their main Editor, so they remain in that main Editor's slot;
they provide runtime clients, not independent authoring slots. Different
GitButler branches applied in one workspace still share one authoring slot.
Use GitButler within a checkout when its branch workflow suits the project;
changing branches does not create isolation or release an Editor claim.

Select an exact discovered instance id. Discovery shows its PID, canonical
project path, shared workspace and owner. Never guess clone paths.
Claim with `bb unity manage claim --instance ID --mode runtime` for
inspection or `--mode authoring` for main-Editor lifecycle and shared writes.
The calling BB thread is the owner; there is no arbitrary owner argument.
Keep the returned claimId. A new claim verifies the served PID with a read-only
ephemeral script outside Assets. Claims persist until released, including across
plugin reloads and idle agent turns. They never expire and cannot be stolen.

Run a Pipeline command with `bb unity manage command --instance ID
--claim CLAIM --command NAME --parameters '{"key":"value"}'`. Commands become
tracked Pipeline jobs. Use `bb unity manage status --instance ID
--claim CLAIM` until `claim.jobId` is null; a terminal job can still have
background Editor work. A pending or uncertain operation blocks later commands
and release. Timeout/cancellation can leave Unity work detached. Do not assume
disconnect means completion. After checking the native job, recorder/input and
other owned work, the owner can use `bb unity manage reconcile
--instance ID --claim CLAIM --confirm --note "observed completion evidence"`.
It also requires the Pipeline to be idle. Another thread cannot reconcile your
claim.

Release with `bb unity manage release --instance ID --claim CLAIM`
after input, jobs and recorders are finished and temporary state is restored.
`bb unity manage recover --instance ID` removes a claim after the old
Editor process is proven gone. Deletion/archive marks an owner orphaned. To
recover that claim while the Editor stays open, use `recover --confirm
--note "observed completion evidence"` only after checking owned input/recorders
and detached work. Native jobs, compiling, imports, builds, bakes, tests, package
work and dialogs must be idle. Restoring an archived thread restores its
ownership protection. Recovery checks BB's current owner record; a missed event
cannot authorize a live-owner takeover. Run ownership commands inside a BB
thread. For discovery outside one, supply `--host`.

Runtime claims allow different agents to inspect distinct clients of one MPPM
workspace. They permit only registered inspection commands. Clones cannot take
authoring claims. Main authoring excludes another thread's runtime/authoring
claim on that shared checkout. Claims coordinate participating tools; direct
Unity CLI, UI and agent-game calls cannot be intercepted. Do not bypass a claim.
Shared Assets/Packages writes and scenario lifecycle require the main authoring
owner. Use the project's existing account, input, capture and scenario rules.
Release client claims before the scenario owner needs the shared authoring
window. Never restart or save a dirty Editor to recover ownership. Physical
focus, screen capture and backend accounts remain shared across checkouts.

CLI identity comes from `BB_THREAD_ID`; it is a coordination interface, not an
access-control boundary. Do not spoof another thread. Managed `list` hides other
owners' claim ids; the public read-only `listUnityEditors` RPC hides all claim
ids, even when a threadId is supplied to select the host. Prefer the native
agent tool when available. Plugin reloads discard unverified read-only probes
and preserve interrupted submissions as uncertain. Release and subsequent
mutations verify native background status before handoff.
