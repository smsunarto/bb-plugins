---
name: unity-editors
description: Discover Unity Editor instances, claim one for a BB thread, run guarded commands, and release ownership through Kitchen Sink.
---

# Unity Editor ownership

Use `bb kitchen-sink editors list` or the `kitchen_sink_editors` agent tool.
Select an exact discovered instance id. Discovery shows the PID, canonical
project path, MPPM shared workspace, and existing owner. Never guess clone paths.

Claim with `bb kitchen-sink editors claim --instance ID --mode runtime` for
inspection or `--mode authoring` for main-Editor lifecycle and shared writes.
The calling BB thread is the owner; there is no arbitrary owner argument.
Keep the returned claimId. A new claim verifies the served PID with a read-only
ephemeral script outside Assets. Claims persist until released, including across
plugin reloads and idle agent turns. They never expire and cannot be stolen.

Run a Pipeline command with `bb kitchen-sink editors command --instance ID
--claim CLAIM --command NAME --parameters '{"key":"value"}'`. Commands become
tracked Pipeline jobs. Use `editors status --instance ID --claim CLAIM` until
`claim.jobId` is null; a terminal job can still have background Editor work. A pending or uncertain operation blocks subsequent commands and release.
Timeout/cancellation can leave Unity work detached. Do not assume disconnect
means completion. After checking the native job, recorder/input and other owned
work, the owner can use `editors reconcile --instance ID --claim CLAIM --confirm
--note "observed completion evidence"`. It also requires the Pipeline to be idle.
Another thread cannot reconcile your claim.

Release with `editors release --instance ID --claim CLAIM` after input, jobs and
recorders are finished and temporary state is restored. `editors recover
--instance ID` removes a claim after the old Editor PID is proven gone.
Deletion/archive marks an owner orphaned. To recover that claim while the Editor
stays open, use `recover --confirm --note "observed completion evidence"` only
after checking owned input/recorders and detached work. Native jobs, compiling,
imports, builds, bakes, tests, package work and dialogs must be idle. Restoring an
archived thread restores its ownership protection. Recovery checks the owner
against BB directly; a missed event cannot authorize a live-owner takeover.
Run these commands inside a BB thread. For discovery outside one, supply `--host`.

Runtime claims allow different agents to inspect distinct clients of the same
MPPM workspace. They permit only the registered inspection command allowlist.
Clones cannot take authoring claims. Main authoring excludes another thread's
runtime/authoring claim on that shared workspace. Claims coordinate participating
tools; direct unity CLI, UI and agent-game calls cannot be intercepted. Do not
bypass a claim. Shared Assets/Packages writes require the main authoring owner.

Keep one checkout and main Editor owner by default. MPPM shares assets/imports
and does not isolate backend accounts. Use the project's existing account,
input, capture, and scenario rules. Release client claims before the scenario
owner needs the shared authoring/lifecycle window. Never restart or save a dirty
Editor to recover ownership. Physical focus and screen capture remain shared.

CLI identity comes from `BB_THREAD_ID`; it is a coordination interface, not an
access-control boundary. Do not spoof another thread. `list` hides other owners'
claim ids. Prefer the native agent tool when available. Plugin reloads discard
unverified read-only probes and preserve interrupted submissions as uncertain.
Release and subsequent mutations verify native background status before handoff.
