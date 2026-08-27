# bb-kit

The framework a bb plugin is written in: the shapes a plugin is made of
and the names they answer to. One context; the consuming plugins under
`plugins/` sit outside it. The concern directories (`app/`, `server/`)
have no collective term — prose says "directories";
avoid "slot" and "surface". In identifiers, an acronym is always fully
capitalized — `CLI`, `RPC`, `ID`, `URL` — never `Cli`, `Rpc`, `Id`;
host-owned names (`pluginId`, `BbPluginApi`) stay as bb spells them.

## Language

**Plugin**:
One npm package that bb installs and runs. The package root is the plugin
root.
*Avoid*: extension, app

**Composition root**:
`server/server.ts` — the one file that wires RPCs, Commands, and Agent tools together, and
the only file a generator may ask a human to edit. It is `bb.server`.
*Avoid*: entrypoint, index

**`server/rpc/`**:
The directory of RPCs beside the composition root — one per file, its
test beside it. Follows `dirname(bb.server)`, so a root `server.ts`
keeps units in `rpc/`.

**`server/cli/`**:
The directory of Commands beside the composition root — one per file,
its test beside it. Same `dirname(bb.server)` rule as `server/rpc/`.

**`server/tools/`**:
The directory of Agent tools beside the composition root — one per
file, its test beside it. Same `dirname(bb.server)` rule as
`server/rpc/`.

**`app/`**:
Everything browser-bound; `app/app.tsx` is the app entry. An import
outside `app/` never reaches the browser bundle.

**`server/`**:
The server concern. `server/server.ts` is the composition root. Interned
collaborators, domain modules, `rpc/`, `cli/`, and `tools/` are siblings. A plugin
without a backend omits the directory.

**RPC**:
One remotely callable unit, defined in its own file. Either a Query or a
Mutation. A plugin's RPCs are the `rpc` map on `definePlugin`. The
public name is the map key — camelCase, matching the host (`readFile`).
Renaming one is a breaking change. The host isolates methods by plugin
id on the path; the name is not prefixed.
*Avoid*: procedure, endpoint, handler, method, wire name

**Query**:
An RPC that reads. Declared with `defineQuery`.
*Avoid*: read, getter, fetch

**Mutation**:
An RPC that writes. Declared with `defineMutation`.
*Avoid*: command, action

**Plugin id**:
The id declared on `definePlugin` as `pluginId`. Equals
`derivePluginID(package.json name)`. The CLI mounts as `bb <pluginId>`.
Not a prefix of an RPC's public name.
*Avoid*: namespace, scope, prefix

**Client**:
The typed client for a plugin's RPCs — what the RPC subtree and the UI
imperative escape hatch reach them through. Commands do not take a
client; they take CommandContext and call RPC handlers. The RPC hooks
are the normal UI path.
*Avoid*: caller, stub

**Context**:
The frozen host preset every handler receives: `{ bb }`.
The type is `Context` from `@bb-kit/core/plugin`, whose `bb` is
`BbPluginApi`. Host capabilities (`sdk`, `storage`, …) live on `bb`.
`definePlugin` builds it from the host; there is no author factory
and no Extra fields. `cli` is a Command overlay, not a Context field.
Plugins import `Context`; they do not alias it.
*Avoid*: ctx, deps, environment

**CommandContext**:
What a Command's `run` receives: the plugin Context plus required
`cli` (the host invocation facts: `cwd`, `threadId`, `projectId`,
`signal`). RPC handlers stay typed against Context.
*Avoid*: CLI context (for the whole object)

**RPC hooks**:
The per-RPC React hooks UI code reaches RPCs through — a Query's
`useQuery`, a Mutation's `useMutation` — bound once in `app/rpc.ts`.
*Avoid*: query hooks

**Command**:
One `defineCommand` unit in `server/cli/`, wired into `definePlugin`'s command
map. The only "command" in this context; an RPC that writes is a
Mutation.
*Avoid*: CLI command, subcommand

**RPC subtree**:
The `bb <plugin-id> rpc <name>` family every plugin mounts
automatically — one entry per RPC, taking and printing JSON objects.
Framework-owned; not a Command.
*Avoid*: auto-commands, generated CLI

**Agent tool**:
A capability a plugin exposes to the coding agent driving a thread; the
agent invokes it by name with schema-validated input. Defined with
`defineTool`, one per file in `server/tools/`.
*Avoid*: MCP tool, model tool

**Tool name**:
The public name an Agent tool answers to. Derived by one function,
`toolName`. It replaces every `-` in the plugin id with `_` and appends
`_` plus the `agents.tools` key, the unit's underscored basename.
`notify` plus `user` publishes `notify_user`; authors never type it.
Unique across every installed
plugin — the host does not isolate tools by path the way it isolates
RPCs. Public API; renaming one is a breaking change.
*Avoid*: tool id

**Session**:
One agent run the host assembles inside a thread, and the payload of
configure resolution. `enabled` and a function-valued `agents.skills`
selector receive it as their second parameter; their choices apply when
the next Session starts, never mid-run. `agents.instructions` does not
receive the Session; its second parameter is the Resolution.
*Avoid*: agent run

**Resolution**:
The `{ threadId, projectId }` pair the host hands to
`agents.instructions` each time it resolves a thread's instructions.
Not the Session; it carries none of the Session's environment or
provider facts.
*Avoid*: session (for this parameter)
