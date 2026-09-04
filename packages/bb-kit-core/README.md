# @bb-kit/core

The framework a bb plugin is written in.

A plugin declares RPCs with `defineQuery` / `defineMutation`, adds
Commands with `defineCommand`, and wires everything in one composition
root with `definePlugin`. Every RPC is also a terminal command: the
plugin mounts an `rpc` subtree automatically, one entry per RPC, JSON
object in, JSON object out.

```ts
// src/server/server.ts
import { definePlugin } from "@bb-kit/core/plugin";
import { overview } from "./rpc/overview.ts";
import { status } from "./command/status.ts";

export default definePlugin({
  pluginId: "my-plugin",
  rpc: { overview },
  command: { status },
});
```

`definePlugin` returns a callable factory that also carries the map as
`.rpc`. UI type-only imports the default export and binds
`createRPC<(typeof plugin)["rpc"]>()`. Commands take `CommandContext`
and, when they declare `input`, the schema output of that object. Then
they call RPC `.execute(ctx[, args])`. RPC `execute` infers Context and
takes keyed args. The validating `Client` still serves the `rpc`
subtree.

## Getting started

```sh
npx @bb-kit/core create my-plugin
cd my-plugin
npm test
```

`create` scaffolds a working plugin with RPCs, Commands, UI, and passing
tests. `npx bb-kit add query|mutation|command <name>` grows the surface;
`npx bb-kit check` verifies the wiring.

## Run an isolated bb dev instance

| Goal                                     | Source mode | Command                                               |
| ---------------------------------------- | ----------- | ----------------------------------------------------- |
| Prepare a plugin workspace               | Owned       | `bb-kit dev-instance workspace`                       |
| Test plugins against another bb revision | Owned       | `bb-kit dev-instance workspace --revision <selector>` |
| Give one task its own throwaway bb       | Runtime     | `bb-kit dev-instance workspace --name <name>`         |
| Develop bb with uncommitted changes      | Attached    | `bb-kit dev-instance start --attach .`                |
| Run a tool with instance routing         | Either      | `bb-kit dev-instance run -- <program>`                |

Start the latest official desktop release:

```sh
bb-kit dev-instance start
```

The command resolves the highest `desktop-v*` semver tag from `get-bb/bb`.
It checks that the release commit is on `origin/main`. It records the full
commit before it creates the checkout. A bare repeat uses that recorded commit
without contacting the network.

Use an explicit `latest` selector when you want to check for a newer release:

```sh
bb-kit dev-instance start --revision latest
```

The command refuses to replace an instance when `latest` resolves to another
commit. Pass another `--name`, or destroy the stopped instance first.

Start a branch from a local bb repository:

```sh
bb-kit dev-instance start --name my-branch \
  --revision local:my-branch \
  --repo ~/git/bb
```

Use `origin:my-branch` to fetch and start the selected repository's origin
branch. Use `tag:<tag>` or `commit:<sha>` for an exact revision. Tags and
commits use the official repository unless `--repo` selects another one.

Add `--desktop` to persist the desktop shell as desired runtime state. Add
`--open` to open the app once, after the app health check passes.

### Many runtimes on one checkout

An owned instance is a checkout. It clones bb, installs the dependencies, builds
the plugin SDK, and hands the rest to `scripts/bb-dev-app`. That is minutes and
several gigabytes, and there is no reason to repeat it for a task that only
needs a bb of its own.

A runtime is the cheap half. It borrows an owned instance's checkout and starts
only the dev stack, with its own instance id, data directory, port triple, shim,
and logs. It never fetches, installs, builds, or writes to the checkout, so it
comes up in seconds and several can run at once:

```sh
bb-kit dev-instance workspace --name review-1234
```

A named start borrows by default. bb-kit picks the first sibling instance that
is prepared or running, sits on the same commit, and has its dependencies
installed. Name one with `--from <instance>`, or refuse to borrow at all with
`--owned`. An unnamed start never borrows: it is the workspace host that owns
the checkout the runtimes share.

`status` reports which instance a runtime borrowed. `destroy` removes its data
directory, its logs, and its lease, and never the checkout.

Two limits are deliberate. A runtime is web only, because the desktop shell
reads build output the runtime does not own. A runtime also skips the plugin
builds in `workspace`, because the checkout owner already ran them and the
output is shared.

#### What this bypasses

`scripts/bb-dev-app` and bb's `pnpm dev` both derive the instance id, the data
directory, and the port offset from the checkout's own path, so two stacks on
one path would collide. bb-kit spawns the dev tasks itself and passes those
three as environment instead. It asserts on every start that bb's
`toDevProcessEnv` still exports the same set of keys it mirrors, and fails with
`runtime_env_drift` when that moves, rather than starting a stack wired to a
stale contract.

To develop bb itself, attach the checkout that you are editing:

```sh
cd ~/git/bb
bb-kit dev-instance start --attach .
```

Attached instances run `scripts/bb-dev-app` in place. bb-kit does not fetch,
switch, reset, mark, or remove the checkout, its data directory, or its logs.
`--attach` cannot be combined with `--revision` or `--repo`.

Cold starts can fetch a checkout, install dependencies, build bb's plugin SDK,
and install Electron before startup. By default, bb-kit keeps a short lock wait
and lets bb's launcher enforce its own readiness timeouts. Use `--timeout
SECONDS` when the caller needs an overall start budget.

The implicit instance name first uses `BB_KIT_DEV_NAME`, then a stable hash of
the Git workspace. Outside a Git workspace, it uses `BB_ENVIRONMENT_ID`, then
the current directory. Pass `--name` only when callers should share one
instance.

Inspect and control an instance with these commands:

```sh
bb-kit dev-instance list
bb-kit dev-instance status [NAME]
bb-kit dev-instance logs [NAME] [dev|desktop|launcher] --lines 100
bb-kit dev-instance logs [NAME] dev --follow
bb-kit dev-instance stop [NAME]
bb-kit dev-instance destroy [NAME]
```

`stop` keeps the source. For an owned instance, `destroy` removes only paths
whose owner token and recorded path match the instance state. For an attached
instance, `destroy` leaves the checkout, data directory, and logs in place.

Run the selected checkout's bb CLI without ambient thread routing:

```sh
bb-kit dev-instance exec [NAME] -- plugin types .
bb-kit dev-instance run [NAME] -- pnpm test
eval "$(bb-kit dev-instance env [NAME])"
```

`exec` runs a bb command. `run` requires a running instance and runs any
program with the generated bb shim on `PATH`. Both commands clear ambient bb
routing and track the child. `stop` and `destroy` refuse while that child runs.

The generated bb shim clears known bb routing variables. It then runs
`pnpm -C <checkout> --silent bb:dev`. Relative plugin paths still resolve from
the caller's directory. `env` prints the same App URL, source, instance name,
and `PATH` prefix for an interactive shell.

Prepare a plugin workspace from its root:

```sh
bb-kit dev-instance workspace
bb-kit dev-instance workspace --watch
```

The root `package.json` stores the workspace policy in `bbKit.devInstance`.
The command builds every plugin package in order. It installs plugins whose
recorded source differs from the workspace. It then enables the plugins,
applies the configured experiment and theme values, resets non-secret plugin
settings to their declared defaults, and checks the resulting state.

The workspace command accepts the same owned revision options as `start`. It
does not accept `--attach`. Use `start --attach` for bb core development.

Add `--json` to `start`, `workspace`, `list`, `status`, `stop`, `destroy`, or `env`.
The command writes one schema-versioned JSON object to stdout. Start progress
and diagnostics stay on stderr. The workspace command rejects `--json` with
`--watch` because a watcher does not produce one final result.

Set `BB_KIT_DEV_HOME` to replace the state root. The default is
`$XDG_STATE_HOME/bb-kit/dev`, or `~/.local/state/bb-kit/dev` when XDG state is
unset.

## Subpaths

| Subpath                  | Exports                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@bb-kit/core/plugin`    | `definePlugin`, `hostContext`, types `DefinedPlugin`, `Context`, `HostSeam`                                                                                                                 |
| `@bb-kit/core/rpc`       | `defineQuery`, `defineMutation`, `createClient`, `RPCValidationError`, types `Client`, `RPCContext`, `RPCProcedures`, `JSONObjectSchema`, `StandardSchemaV1`, `SchemaInput`, `SchemaOutput` |
| `@bb-kit/core/command`   | `defineCommand`, `argv`, `CommandError`, types `CommandResult`, `CommandContext`                                                                                                            |
| `@bb-kit/core/rpc/query` | `createRPC`, `PluginQueryBoundary` (browser)                                                                                                                                                |
| `@bb-kit/core/testing`   | `installDom`, `stubClient`, `stubHostContext`                                                                                                                                               |

There is no root export; the subpath is the unit.

## License

MIT
