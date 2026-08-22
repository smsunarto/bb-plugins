# @bb-kit/core

The framework a bb plugin is written in.

A plugin declares procedures with `defineQuery` / `defineMutation`,
composes them into a namespaced RPC with `defineRPC`, adds CLI commands
with `defineCommand`, and wires everything in one composition root with
`definePlugin`. Every procedure is also a terminal command: the CLI
mounts an `rpc` subtree automatically, one subcommand per procedure,
JSON object in, JSON object out.

```ts
// server.ts
import { definePlugin } from "@bb-kit/core/plugin";
import { defineRPC, type ClientFor } from "@bb-kit/core/rpc";
import { overview } from "./rpc/overview.ts";
import { status } from "./cli/status.ts";
import { createContext } from "./server/context.ts";

export const rpc = defineRPC({
  namespace: "my-plugin",
  procedures: { overview },
});
export type RPC = typeof rpc;
export type Client = ClientFor<RPC>;

export default definePlugin({
  rpc,
  cli: { summary: "My plugin", commands: { status } },
  context: createContext,
});
```

## Getting started

```sh
npx @bb-kit/core create my-plugin
cd my-plugin
npm test
```

`create` scaffolds a working plugin — procedures, CLI, UI, and passing
tests. `npx bb-kit add query|mutation|command <name>` grows the surface;
`npx bb-kit check` verifies the wiring.

## Subpaths

| Subpath                | Exports                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@bb-kit/core/plugin`  | `definePlugin`                                                                                                |
| `@bb-kit/core/rpc`     | `defineQuery`, `defineMutation`, `defineRPC`, `createClient`, `wireName`, `RPCValidationError`, and the types |
| `@bb-kit/core/cli`     | `defineCommand`, `invokeCLI`, `CLIError`, and the types                                                       |
| `@bb-kit/core/query`   | `createRPC`, `PluginQueryBoundary` (browser)                                                                  |
| `@bb-kit/core/testing` | `installDom`                                                                                                  |

There is no root export; the subpath is the unit.

## License

MIT
