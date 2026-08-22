# bb-kit

The framework a bb plugin is written in: the shapes a plugin is made of
and the names they answer to. One context; the consuming plugins under
`plugins/` sit outside it. The concern directories (`rpc/`, `cli/`,
`ui/`, `server/`) have no collective term — prose says "directories";
avoid "slot" and "surface". In identifiers, an acronym is always fully
capitalized — `CLI`, `RPC`, `ID`, `URL` — never `Cli`, `Rpc`, `Id`;
host-owned names (`pluginId`, `BbPluginApi`) stay as bb spells them.

## Language

**Plugin**:
One npm package that bb installs and runs. The package root is the plugin
root.
_Avoid_: extension, app

**Composition root**:
`server.ts` — the one file that wires Procedures, the RPC, and CLI
commands together, and the only file a generator may ask a human to edit.
_Avoid_: entrypoint, index

**`rpc/`**:
The directory of Procedures — one per file, its test beside it.

**`cli/`**:
The directory of CLI commands — one per file, its test beside it.

**`ui/`**:
Everything browser-bound; `ui/app.tsx` is the app entry. An import
outside `ui/` never reaches the browser bundle.

**`server/`**:
Optional internal support code (context assembly, repositories, domain
modules). Not part of the plugin's public surface.

**Procedure**:
One remotely callable unit, defined in its own file. Either a Query or a
Mutation.
_Avoid_: endpoint, handler, method

**Query**:
A Procedure that reads. Declared with `defineQuery`.
_Avoid_: read, getter, fetch

**Mutation**:
A Procedure that writes. Declared with `defineMutation`. "Command" always
means a CLI command, never a Procedure.
_Avoid_: command, action

**RPC**:
The namespaced map of a plugin's Procedures, composed in the composition
root with `defineRPC`.
_Avoid_: router, registry, catalog

**Namespace**:
The RPC map's prefix for Wire names. Always equal to the plugin id.
_Avoid_: scope, prefix

**Wire name**:
The public name a Procedure answers to over RPC, derived as
`snake(namespace)_snake(key)`. Public API — renaming one is a breaking
change.
_Avoid_: wire method, RPC name, method name

**Client**:
The typed client for a plugin's RPC — what CLI commands and the RPC
subtree reach Procedures through. In the UI it is the imperative escape
hatch — the RPC hooks are the normal path.
_Avoid_: caller, stub

**Context**:
The dependencies a plugin's handlers receive — one `Context` type,
assembled in `server/context.ts` by its exported `createContext`.
_Avoid_: ctx, deps, environment

**RPC hooks**:
The per-Procedure React hooks UI code reaches Procedures through — a
Query's `useQuery`, a Mutation's `useMutation` — bound once, with the
Namespace, in `ui/rpc.ts`.
_Avoid_: query hooks

**CLI command**:
One `defineCommand` unit in `cli/`, wired into `definePlugin`'s
command map in the composition root and executed by bb's plugin CLI
host. The only "command"
in this context; a Procedure that writes is a Mutation.
_Avoid_: subcommand

**RPC subtree**:
The `bb <plugin-id> rpc <procedure>` command family every plugin's CLI
mounts automatically — one subcommand per Procedure, taking and printing
JSON objects. Framework-owned; not a CLI command.
_Avoid_: auto-commands, generated CLI

**Agent tool**:
A capability a plugin exposes to the coding agent driving a thread; the
agent invokes it by name with schema-validated input. Tool names are
public API, unique across every installed plugin.
_Avoid_: MCP tool, model tool
