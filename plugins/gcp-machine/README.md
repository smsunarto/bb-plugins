# GCP Machine

Enroll one existing Compute Engine VM as a persistent BB machine. BB starts it
when thread work needs it. The plugin checks once per minute and requests BB
suspension after an hour without observed work. Suspension uses GCE **stop**;
resume uses **start**, followed by BB's enrolled-machine bootstrap path to clear
the suspension marker and wait for its daemon to reconnect. Removing the BB registration retains the VM and disks.

## Setup

Configure the plugin in BB settings. Supply the project, zone, VM name and numeric
instance ID. The ID prevents controlling a replacement VM with the same name.
Only persistent disks are supported.

Choose a controller outside the target VM. `controllerHostId` routes Google Cloud
commands through that BB host; empty uses the BB server. That controller needs
`gcloud`, authentication with VM read/start/stop and operation-read permissions,
and IAP SSH access for enrollment and resume. Set `gcloudPath`, `account`, and `sshUser` for
that controller. It must stay connected to BB for power control to work. A phone
or browser does not need Google Cloud tools or credentials. Host execution
supports macOS and Linux.

For a previously manual machine, set `previousHostId`. Before removing that old
registration, inspect its environments and running work: BB retires environments
during removal. The new provider registration gets a new host identity. This
plugin does not migrate old thread/environment associations.

Then add a machine with the **GCP Machine** provider. Enrollment starts the
existing VM, verifies its identity, and passes BB's bootstrap bundle over IAP SSH.
SSH host keys must already be trusted on the controller. The plugin never creates
or deletes a VM. VM identity is pinned at enrollment; target changes apply to the next enrollment.
Controller/access settings and `autoStop` apply immediately, including during
recovery from a failed request.

## Idle behavior

- Active, starting, stopping, queued or background agent work keeps the VM awake.
- Environment provisioning/retirement and any starting, running or disconnected
  BB terminal session keep it awake, including terminals in archived threads.
  Close unused terminal sessions to allow automatic stop.
- Disconnection, incomplete reads, controller errors and plugin reloads start a
  fresh hour of grace. Unknown activity never establishes idleness.
- Each scan is bounded to 2,000 environments and 2,000 threads per archive state,
  with a 45-second activity-read deadline. Exceeding those limits disables that
  stop attempt and shows the reason in `status`; it never truncates history and
  assumes the omitted sessions are idle.
- BB's existing suspension path can interrupt work admitted between the final
  check and suspension. The SDK does not expose atomic idle-only suspension.
- Processes outside BB, exposed web services, editor activity and ordinary file
  browsing are not tracked. Disable `autoStop` while relying on those workloads.
  Shutdown preserves disks, not running processes or unsaved memory.

Use `bb gcp-machine status` to inspect the binding, cloud state, idle reason and
errors. `bb gcp-machine wake` explicitly resumes the registered machine. It also
starts a VM stopped outside BB and restarts a disconnected enrolled daemon,
including recovery from a failed suspension that left BB's suspension marker.
Queued thread work resumes a BB-suspended machine through BB's native lifecycle.

Cloud request IDs persist across retries. An unresolved power operation is
reconciled before an opposite operation or registration cleanup. A confirmed 404
for the pinned numeric instance ID settles that operation so a deleted VM cannot
block removal or re-enrollment. Authentication and transport failures retain the
pending operation. No Google access token is stored in BB settings, resources or logs.
