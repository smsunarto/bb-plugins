---
name: gcp-machine
description: Inspect the GCP Machine plugin's idle policy, diagnose wake failures, or configure enrollment of an existing Compute Engine VM.
---

# GCP Machine

Run `bb gcp-machine status` first. Read `error`, `idleStatus`, `hostId`, and
`cloud.status` separately: a running VM does not prove that its BB daemon is
connected. Use `bb gcp-machine wake` for an explicit wake; thread work uses BB's
native resume path. Verify the registered host is connected before reporting it
ready for work.

For configuration or migration, read [the plugin README](../../README.md), then
inspect `bb plugin config gcp-machine --json` and `bb machine show <hostId>`.
The controller is a separate machine with Google credentials. Use the configured
controller's host-targeted tools; the UI client and BB server need not be that
controller.

Manual-host removal retires its environments. Confirm the intended replacement
and preserve necessary environment references before enrollment. Removing this
plugin's registration retains the cloud VM. Keep failed/uncertain lifecycle
operations visible and reconcile them through BB; a second enrollment must not
be used to bypass an unresolved power operation.

Report remaining limits plainly: a live terminal inhibits auto-stop; external
processes are untracked; native BB suspension has a check-to-suspend race. Use
`autoStop=false` when an external workload must remain running.
