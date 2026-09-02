# @bb-kit/core

The framework a bb plugin is written in.

A plugin declares RPCs with `defineQuery` / `defineMutation`, adds
Commands with `defineCommand`, and wires everything in one composition
root with `definePlugin`. Every RPC is also a terminal command: the
plugin mounts an `rpc` subtree automatically, one entry per RPC, JSON
object in, JSON object out.

```ts
// server/server.ts
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

Start the latest official desktop release:

```sh
bb-kit dev start
```

The command resolves the highest `desktop-v*` semver tag from `get-bb/bb`.
It records the full commit before it creates the checkout. A bare repeat uses
that recorded commit without contacting the network.

Use an explicit `latest` selector when you want to check for a newer release:

```sh
bb-kit dev start --revision latest
```

The command refuses to replace an instance when `latest` resolves to another
commit. Pass another `--name`, or destroy the stopped instance first.

Start a branch from a local bb repository:

```sh
bb-kit dev start --name my-branch \
  --revision local:my-branch \
  --repo ~/git/bb
```

Use `origin:my-branch` to fetch and start the selected repository's origin
branch. Use `tag:<tag>` or `commit:<sha>` for an exact revision. Tags and
commits use the official repository unless `--repo` selects another one.

Add `--desktop` to persist the desktop shell as desired runtime state. Add
`--open` to open the app once, after the app health check passes.

The implicit instance name uses `BB_ENVIRONMENT_ID` when present. Otherwise,
it uses a stable hash of the Git workspace or current directory. Pass
`--name` only when callers should share one instance.

Inspect and control an instance with these commands:

```sh
bb-kit dev list
bb-kit dev status [NAME]
bb-kit dev logs [NAME] [dev|desktop|launcher] --lines 100
bb-kit dev logs [NAME] dev --follow
bb-kit dev stop [NAME]
bb-kit dev destroy [NAME]
```

`stop` keeps the checkout and immutable revision. `destroy` removes only
paths whose owner token and recorded path match the instance state.

Run the selected checkout's bb CLI without ambient thread routing:

```sh
bb-kit dev exec [NAME] -- plugin types .
eval "$(bb-kit dev env [NAME])"
```

The generated bb shim clears known bb routing variables. It then runs
`pnpm -C <checkout> --silent bb:dev`. Relative plugin paths still resolve from
the caller's directory.

Add `--json` to `start`, `list`, `status`, `stop`, `destroy`, or `env`.
The command writes one schema-versioned JSON object to stdout. Start progress
and diagnostics stay on stderr.

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
