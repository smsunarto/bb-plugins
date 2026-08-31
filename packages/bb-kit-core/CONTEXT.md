# bb-kit

The framework a bb plugin is written in: the shapes a plugin is made of
and the names they answer to. One context; the consuming plugins under
`plugins/` sit outside it. The runtime directories (`app/`, `server/`, `host/`)
have no collective term — prose says "directories";
avoid "slot" and "surface". In identifiers, an acronym is always fully
capitalized — `CLI`, `RPC`, `ID`, `URL` — never `Cli`, `Rpc`, `Id`;
host-owned names (`pluginId`, `BbPluginApi`) stay as bb spells them.

## Language

**Plugin**:
One npm package that bb installs and runs. The package root is the plugin
root. Runtime directories (`server/`, `app/`, and `host/`) are siblings.
_Avoid_: extension, app

**Composition root**:
`server/server.ts` — the one file that wires RPCs, Commands, and Agent tools together, and
the only file a generator may ask a human to edit. It is `bb.server`.
_Avoid_: entrypoint, index

**`server/rpc/`**:
The directory of RPCs beside the composition root — one per file, its
test beside it. Follows `dirname(bb.server)`, so a root `server.ts`
keeps units in `rpc/`.

**`server/command/`**:
The directory of Commands beside the composition root — one per file,
its test beside it. Same `dirname(bb.server)` rule as `server/rpc/`.

**`server/tools/`**:
The directory of Agent tools beside the composition root — one per
file, its test beside it. Same `dirname(bb.server)` rule as
`server/rpc/`.

**`app/`**:
Everything browser-bound; `app/app.tsx` is the app entry. App code may
import portable `shared/` modules. Its only server edge is the type-only
`app/rpc.ts` import of `server/server.ts`.

**`server/`**:
The server concern. `server/server.ts` is the composition root. Interned
collaborators, domain modules, `rpc/`, `command/`, and `tools/` are siblings. A plugin
without a backend omits the directory.

**`host/`**:
Everything bundled into the supervised Node worker that runs on an enrolled
host; `host/host.ts` is `bb.host`. A plugin without machine-local work omits
the directory. Server code calls it through the typed BB host client rather
than importing its implementation.

**`shared/`**:
Portable contracts and values consumed by at least two shipped runtimes.
It imports no runtime directory and stays browser-safe. Node-only code shared
by `server/` and `host/` uses the explicit `shared/node/` exception; `app/`
never imports that subtree. A one-runtime helper stays with its runtime owner.

**`testing/`**:
Reusable test helpers owned by one runtime, such as `host/testing/`. Shipped
entry graphs never import it. Tests with one subject remain beside that
subject.

**`test/`**:
Optional package-wide integration, artifact, and import-boundary tests. It is
not the home for ordinary unit tests.

**RPC**:
One remotely callable unit, defined in its own file. Either a Query or a
Mutation. A plugin's RPCs are the `rpc` map on `definePlugin`. The
public name is the map key — camelCase, matching the host (`readFile`).
Renaming one is a breaking change. The host isolates methods by plugin
id on the path; the name is not prefixed.
_Avoid_: procedure, endpoint, handler, method, wire name

**Query**:
An RPC that reads. Declared with `defineQuery`.
_Avoid_: read, getter, fetch

**Mutation**:
An RPC that writes. Declared with `defineMutation`.
_Avoid_: command, action

**Plugin id**:
The id declared on `definePlugin` as `pluginId`. Equals
`derivePluginID(package.json name)`. The CLI mounts as `bb <pluginId>`.
Not a prefix of an RPC's public name.
_Avoid_: namespace, scope, prefix

**Client**:
The typed client for a plugin's RPCs — what the RPC subtree and the UI
imperative escape hatch reach them through. Commands do not take a
client; they take CommandContext and call RPC `.execute`. The RPC hooks
are the normal UI path.
_Avoid_: caller, stub

**Context**:
The frozen host preset every execute receives: `{ bb }`.
The type is `Context` from `@bb-kit/core/plugin`, whose `bb` is
`BbPluginApi`. Host capabilities (`sdk`, `storage`, …) live on `bb`.
`definePlugin` builds it from the host; there is no author factory
and no Extra fields. Host overlay fields live on CommandContext.
The second argument of a Command's `execute` is the schema output of
its argv-bound input object. Host `cli.run` is the only string parser.
Plugins import `Context`; they do not alias it.
The binding is `ctx`.
_Avoid_: deps, environment

**CommandContext**:
What a Command's `execute` receives as `ctx`: the plugin Context and the
host invocation fields (`cwd`, `threadId`, `projectId`, `signal`).
Inferred from `defineCommand`. Authors do not annotate it.
The second argument is the schema output, not CommandContext. RPC `execute` infers
Context; authors do not annotate it. The payload is keyed fields, not
`{ args, options }`.
The binding is `ctx`.
_Avoid_: CLI context (for the whole object)

**Command input**:
The second argument of a Command's `execute` when the command declares
`input`. Each field is branded with one argv binding
(`argv.argument`, `optionalArgument`, `words`, `option`, `flag`).
Tests call `execute(ctx, parsed)`. Host `cli.run(argv)` parses strings.
_Avoid_: `{ args, options }`, commander `configure`, `.invoke`

**RPC hooks**:
The per-RPC React hooks UI code reaches RPCs through — a Query's
`useQuery`, a Mutation's `useMutation` — bound once in `app/rpc.ts`.
_Avoid_: query hooks

**Command**:
One `defineCommand` unit in `server/command/`, wired into `definePlugin`'s
`command` map. The only "command" in this context; an RPC that writes is a
Mutation. `execute` returns CommandResult. Throw CommandError to exit with
a chosen code.
_Avoid_: CLI command, subcommand, CLICommand

**CommandResult**:
What a Command's `execute` returns: `{ exitCode, stdout?, stderr? }`.
The host CLI protocol uses this same shape.
_Avoid_: CLIResult

**CommandError**:
Thrown from `execute` to exit with a chosen code.
`new CommandError(message, { exitCode = 1 })`.
_Avoid_: CLIError

**RPC subtree**:
The `bb <plugin-id> rpc <name>` family every plugin mounts
automatically — one entry per RPC, taking and printing JSON objects.
Framework-owned; not a Command.
_Avoid_: auto-commands, generated CLI

**Agent tool**:
A capability a plugin exposes to the coding agent driving a thread; the
agent invokes it by name with schema-validated input. Defined with
`defineTool`, one per file in `server/tools/`.
_Avoid_: MCP tool, model tool

**Tool name**:
The public name an Agent tool answers to. Derived by one function,
`toolName`. It replaces every `-` in the plugin id with `_` and appends
`_` plus the `agents.tools` key, the unit's underscored basename.
`notify` plus `user` publishes `notify_user`; authors never type it.
Unique across every installed
plugin — the host does not isolate tools by path the way it isolates
RPCs. Public API; renaming one is a breaking change.
_Avoid_: tool id

**Session**:
One agent run the host assembles inside a thread, and the payload of
configure resolution. `enabled` and a function-valued `agents.skills`
selector receive it as their second parameter; their choices apply when
the next Session starts, never mid-run. `agents.instructions` does not
receive the Session; its second parameter is the Resolution.
_Avoid_: agent run

**Resolution**:
The `{ threadId, projectId }` pair the host hands to
`agents.instructions` each time it resolves a thread's instructions.
Not the Session; it carries none of the Session's environment or
provider facts.
_Avoid_: session (for this parameter)
