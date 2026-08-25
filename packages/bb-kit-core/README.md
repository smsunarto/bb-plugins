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
import { status } from "./cli/status.ts";

export default definePlugin({
  pluginId: "my-plugin",
  rpc: { overview },
  cli: { status },
});
```

`definePlugin` returns a callable factory that also carries the map as
`.rpc`. UI type-only imports the default export and binds
`createRPC<(typeof plugin)["rpc"]>()`. Commands take `CommandContext`
(the plugin `Context` plus required `cli`) and call
`.handler(context[, input])`. RPC handlers stay typed against the base
Context. The validating `Client` still serves the `rpc` subtree.

## Getting started

```sh
npx @bb-kit/core create my-plugin
cd my-plugin
npm test
```

`create` scaffolds a working plugin with RPCs, CLI, UI, and passing
tests. `npx bb-kit add query|mutation|command <name>` grows the surface;
`npx bb-kit check` verifies the wiring.

## Subpaths

| Subpath                  | Exports                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@bb-kit/core/plugin`    | `definePlugin`, `hostContext`, types `DefinedPlugin`, `Context`, `HostSeam`                                                                                                                 |
| `@bb-kit/core/rpc`       | `defineQuery`, `defineMutation`, `createClient`, `RPCValidationError`, types `Client`, `RPCContext`, `RPCProcedures`, `JSONObjectSchema`, `StandardSchemaV1`, `SchemaInput`, `SchemaOutput` |
| `@bb-kit/core/cli`       | `defineCommand`, `CLIError`, types `CLIResult`, `CLIContext`, `CommandContext`, `DefinedCommand`                                                                                            |
| `@bb-kit/core/rpc/query` | `createRPC`, `PluginQueryBoundary` (browser)                                                                                                                                                |
| `@bb-kit/core/testing`   | `installDom`, `stubClient`, `stubHostContext`                                                                                                                                               |

There is no root export; the subpath is the unit.

## License

MIT
