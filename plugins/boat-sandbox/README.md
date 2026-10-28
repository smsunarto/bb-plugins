# Boat Sandbox

Run bb threads in on-demand [Boat](https://boat.dev) sandboxes: full Ubuntu
virtual machines billed per second. Install the plugin, paste a Boat API key
in Settings → Plugins → Boat Sandbox, and the project picker offers **Boat
Sandbox** under **New machine**. Each machine is one Boat sandbox that bb
stops when it sits idle and resumes from its saved disk when work arrives.

## Setup

1. Install the Boat CLI and sign in (`curl -fsSL https://boat.dev/install | sh`),
   or use the dashboard.
2. Create a scoped key: `boat api-key create bb --preset ci`. The `ci` preset
   covers create, read, stop, resume, exec, files and deleting the sandboxes it
   created. An older `ci` key without resume or `sandbox.delete-own` must be
   recreated.
3. Paste the secret into the plugin's `apiKey` setting and reload the plugin.
4. Run `bb boat account inspect` to confirm the connection without allocating
   anything.

Boat clones repositories and injects secrets through its
[environments](https://docs.boat.dev/environments.md). Set `environment` to a
named one, or leave it blank for your account default. bb still sets up the
project checkout itself; a Boat environment is for extra credentials and
logins the sandbox should start with.

## Settings

| Setting         | Meaning                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`        | Required Boat API key, stored as a secret.                                                                                                        |
| `apiBase`       | `https://boat.dev/api/v1` unless Boat is self-hosted.                                                                                             |
| `defaultType`   | Size for machines whose thread picked none: `small`, `default`, `large` or `xlarge`.                                                              |
| `environment`   | Boat environment new sandboxes attach to; blank uses the account default.                                                                         |
| `idleMinutes`   | Stop a sandbox after this long without bb work, default 15. `0` leaves stopping to Boat.                                                          |
| `autoStopHours` | Boat's own auto-stop, default 24, used as a backstop. The plugin extends it while the machine is active. `0` disables it (not on the free trial). |

The composer chip picks a size per thread and, when the account has
[saved snapshots](https://docs.boat.dev/snapshots/templates.md), the snapshot
the sandbox starts from. The CLI equivalent is
`bb machine create --provider boat-sandbox --machine-inputs '{"type":"large","from":"web-stack"}'`.
`bb boat launch options` lists what the account can use right now.

## Lifecycle

Creation asks Boat for a sandbox labelled with bb's machine key and sends an
idempotency key, so a lost response or a retried launch finds the same
sandbox instead of paying for two. The sandbox id is checkpointed before bb
installs its daemon, which runs over Boat's command API: argv runs detached,
stdin is staged in `/tmp` (never snapshotted) and removed afterwards, and
output streams back into the launch log.

A stop asks Boat to save the disk and remove the machine. Boat keeps the disk
of a stopped sandbox for 14 days and resumes it on a new machine with the same
id; bb's daemon is restarted and the checkout is not set up again. Running
processes do not survive a stop. After 14 days Boat deletes the disk and the
plugin refuses to resume; remove the machine or save a saved snapshot before
then. A sandbox in `error` resumes from its newest background snapshot, which
can be up to a minute old.

The once-a-minute sweep stops idle machines through core, converges core when
Boat stopped a sandbox by itself (auto-stop, empty wallet), and moves Boat's
auto-stop deadline forward while the machine is active. Open terminals and
active threads count as activity. Removing a machine deletes the sandbox and
its snapshots; saved snapshots stay.

Use `bb machine list --json` for core state and
`bb boat machine inspect HOST_ID --json` for Boat's view: phase, auto-stop
deadline, hydration, disk expiry. The same data is available through the
plugin's `boatRpcContract` (`account.inspect`, `machine.inspect`,
`launch.options`) and `sdk.plugins.callRpc`.

## Limits

- Boat's API key, environment, saved snapshots and billing are managed with
  the `boat` CLI or dashboard, not from bb.
- Start limits apply per plan: create and resume each count as one start.
  A refused start fails the launch with Boat's message; retry after the window.
- Lifecycle operations check that the configured key belongs to the account
  that created the machine and refuse another account.
- Verified against a fake Boat API in tests; the live Boat API was not
  exercised when this plugin was written.
