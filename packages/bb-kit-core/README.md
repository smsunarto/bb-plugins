# @bb-kit/core

The framework a bb plugin is written in.

A plugin declares RPCs with `defineQuery` / `defineMutation`, CLI
commands with `defineCommand`, agent tools with `defineTool`, and wires
everything in one composition root with `definePlugin`.

```ts
// src/server/server.ts
import { definePlugin } from "@bb-kit/core/plugin";
import { openStore } from "./lib/store.ts";
import { overview } from "./rpc/overview.ts";
import { status } from "./command/status.ts";

export default definePlugin({
  pluginId: "my-plugin",
  services: (bb) => ({ store: openStore(bb) }),
  rpc: { overview },
  command: { status },
});
```

`definePlugin` returns a callable factory that also carries the map as
`.rpc`. UI type-only imports the default export and binds
`createRPC<(typeof plugin)["rpc"]>()`.

## Context and services

Every handler (`execute` on RPCs, commands, and tools, plus `setup`)
receives a frozen `ctx`: `{ bb }` plus whatever `services(bb)` returns.
A handler states what it needs by annotating `ctx`:

```ts
// src/server/rpc/overview.ts
export const overview = defineQuery({
  output: overviewSchema,
  execute: (ctx: Context<{ store: Store }>) => ctx.store.overview(),
});
```

`definePlugin` fails to type-check until `services` provides every field
some handler demands. `services` runs once, synchronously, before
anything registers. Use it instead of a module-level `WeakMap` keyed by
`bb`.

## Commands

`defineCommand` takes the SDK's CLI declarations (`options`,
`positionals`, `constraints`), so bb parses argv, renders `--help`, and
reports usage errors. `execute` gets typed values and the invocation's
`cwd`, `threadId`, and `signal` on `ctx`. Throw `PluginCliError` for a
failure the caller should see as a usage-style error.

```ts
export const cat = defineCommand({
  summary: "Print a file",
  positionals: [{ name: "path", description: "File to print", required: true }],
  options: { upper: { type: "boolean", description: "Uppercase" } },
  execute: (ctx, { positionals, options }) => ({ exitCode: 0, stdout: `${positionals.path}\n` }),
});
```

Every RPC is also callable from the terminal:
`bb <plugin> rpc <method> ['{"json":"object"}']` validates the input
in-process and prints the result as JSON.

## Getting started

Scaffolding, `add`, `check`, and isolated bb dev instances live in
[@bb-kit/dev](../bb-kit-dev).

## Subpaths

| Subpath                  | Exports                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@bb-kit/core/plugin`    | `definePlugin`, types `DefinedPlugin`, `Context`, `PluginErrorReporterFactory`, `PluginPerformanceReporterFactory`                                   |
| `@bb-kit/core/rpc`       | `defineQuery`, `defineMutation`, `callProcedure`, `RPCValidationError`, types `Client`, `RPCContext`, `RPCProcedures`, `SchemaInput`, `SchemaOutput` |
| `@bb-kit/core/command`   | `defineCommand`, `PluginCliError`, types `CommandContext`, `CommandResult`                                                                           |
| `@bb-kit/core/tools`     | `defineTool`, types `ToolContext`, `ToolResult`, `ToolPresentation`                                                                                  |
| `@bb-kit/core/rpc/query` | `createRPC`, `PluginQueryBoundary`, `pluginQueryClient` (browser)                                                                                    |
| `@bb-kit/core/names`     | `camelName`, `unitKey`, `toolName`, and the naming patterns `bb-kit check` enforces                                                                  |
| `@bb-kit/core/testing`   | `installDom`. Use `createFakePluginHost` from `@get-bb/plugin-sdk/testing` for a fake `bb`.                                                          |

There is no root export; the subpath is the unit.

## License

MIT
