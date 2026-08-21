# bb-kit framework spec

Status: implemented — `packages/bb-kit` is the built thing (106/106
tests, 2026-08-21), and this spec now documents it.
Baseline: bb 0.39 · `@get-bb/plugin-sdk` 0.4.8 · Node ≥ 22.19 (bb's own
engines floor), verified against the pinned dev worktree
(`~/.bb/worktrees/dev/bb`, `desktop-v0.39.0`) on 2026-08-21. In-body
verification citations (SDK 0.4.6, bb 0.38, in §5–§6) record the version
they were verified against and are historical, not stale. Decisions live
in `docs/adr/0001`–`0014`, vocabulary in `packages/bb-kit/CONTEXT.md`,
the authoring loop in `docs/bb-kit-dev-workflow.md`. Supersedes
`docs/bb-plugin-framework-spec.md` (bb-kit 0.1).

The map: §1 the package, §2 the plugin it produces, §3–§5 the three API
surfaces (`./rpc`, `./cli`, `./query`), §6 how it all lands on bb, §7 the
`bb-kit` bin, §8 testing, §9–§10 what the rewrite deliberately leaves
behind. History — what bb-kit 0.1 or the reconsider branch did, and why
the rewrite differs — is set off in `> Aside:` blockquotes; skip every one
and the contract still reads whole.

## 1. Package

One published package, `@bb-kit/core` (ADR-0004), released to npm via
Changesets. Plugins ship over git (ADR-0011); the framework itself ships
over npm because `npx @bb-kit/core create` must work in an empty
directory.

There is no root export. Importing `@bb-kit/core` fails module resolution
on purpose: the subpath is the unit.

> Aside: the reconsider branch aliased `.` to the rpc module, which read
> as arbitrary.

| Subpath     | Runs in            | Exports                                                                                                                                                                                                |
| ----------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `./plugin`  | server, tests      | `definePlugin`                                                                                                                                                                                         |
| `./rpc`     | server, CLI, tests | `defineQuery`, `defineMutation`, `defineRPC`, `createClient`, `wireName`, `RPCValidationError`, types `ClientFor`, `RPCContext`, `JSONObjectSchema`, `StandardSchemaV1`, `SchemaInput`, `SchemaOutput` |
| `./cli`     | server, tests      | `defineCommand`, `invokeCLI`, `CLIError`, types `CLIResult`, `CLIContext`                                                                                                                              |
| `./query`   | browser            | `createRPC`, `PluginQueryBoundary`                                                                                                                                                                     |
| `./testing` | tests              | `installDom`                                                                                                                                                                                           |

bin: `bb-kit` — `create` / `add` / `check`, nothing else (§7; ADR-0009,
ADR-0010).

**Naming.** An acronym in an identifier is always fully capitalized —
`RPC`, `CLI`, `ID`, `URL` — never `Rpc`, `Cli`, `Id`. Host-owned names
cross the seam (§6) verbatim (`BbPluginApi`, `pluginId`, the `CLIContext`
fields), because mirroring bb's spelling matters more at the seam than
enforcing ours.

**Dependencies.** `commander` ^13 is the only runtime dependency.
Everything else is an optional peer dependency, each satisfied by the
scaffold (§7 owns the authoritative scaffold manifest):

- `@get-bb/plugin-sdk` — wide 0.x range; the plugin pins the exact
  version. bb-kit imports only its `/app` subpath at UI runtime and
  `/internal/host-policy` inside `check`.
- `react` ≥ 19 and `@tanstack/react-query` ^5 — needed only when
  `./query` is imported.
- `jsdom` — only when `installDom` is called.
- `typescript` — only by `bb-kit check`.

Standard Schema v1 is a vendored ~30-line type interface, not a
dependency; bb-kit never depends on zod — the plugin does. bb-kit's
emitted declarations never reference SDK types (§6). Source is
erasable-syntax TypeScript (ADR-0006).

## 2. The plugin bb-kit produces

Package root is the plugin root. Concern directories `rpc/`, `cli/`,
`ui/`, `server/`; one file per Procedure or CLI command, with its test
beside it. `server.ts` is the composition root and the only file a
generator ever asks a human to edit (ADR-0007, ADR-0009). Full tree and
scripts: `docs/bb-kit-dev-workflow.md`.

A complete composition root — this is the whole ceremony:

```ts
// server.ts
import { definePlugin } from "@bb-kit/core/plugin";
import { defineRPC, type ClientFor } from "@bb-kit/core/rpc";
import { overview } from "./rpc/overview.ts";
import { readFile } from "./rpc/read-file.ts";
import { saveFile } from "./rpc/save-file.ts";
import { status } from "./cli/status.ts";
import { cat } from "./cli/cat.ts";
import { createContext } from "./server/context.ts";

export const rpc = defineRPC({
  namespace: "dotfiles",
  procedures: { overview, readFile, saveFile },
});
export type RPC = typeof rpc;
export type Client = ClientFor<RPC>;

export default definePlugin({
  rpc,
  cli: {
    summary: "Inspect and sync managed dotfiles",
    commands: { status, cat },
  },
  context: createContext,
});
```

The unit imports are named imports: a unit — one procedure or CLI
command, alone in its file (§3, §4) — declares one identifier that
becomes the procedures or commands key by shorthand, so the name is written
once, at the definition, and tsc checks the chain everywhere else. The
one exception is a hyphenated CLI command, keyed by its quoted kebab
name (§4) — that string is guarded by `check` (§7 rule 1), not tsc.

`definePlugin` returns the plugin's entry factory — an async function
bb calls with the host API and awaits (bb loads `server.ts` from source
via jiti, on a 30 s budget). It is one of a plugin's two default
exports, both host-required (§3); the other is the app in `ui/app.tsx`
(§6). The entries:

- `rpc` — required even for a CLI-only plugin: its namespace is the
  plugin id, and it is the `bb <id>` the host mounts (§4).
- `cli` — optional; `{ summary, commands }` — curated commands beside
  the always-mounted RPC subtree (§4). With no `cli` entry the CLI
  still mounts: the subtree alone, under a default summary. There is no
  CLI `name` field: the CLI mounts as the RPC namespace, so plugin id,
  namespace, and `bb <id>` are one name — and the package name derives
  to it (§7).
- `context` — the callback assembling the plugin's context from `bb`;
  it may be async, and its (awaited) return must satisfy
  `RPCContext<RPC>` (§3) — a context missing a field some handler
  demands is a compile error on this entry. The scaffold passes
  `createContext` point-free.
- `setup?` — optional; the escape hatch out of declarative wiring,
  `(bb, { client, context })`, awaited after registration — `client` is
  the plugin's own typed Client (§3). Settings,
  `bb.status.needsConfiguration`, and `bb.onDispose` are plain SDK
  calls here — bb-kit adds no lifecycle of its own.

`definePlugin` constrains the `commands` map against the RPC: every
command must accept the plugin's `Client`, so a command hand-annotated
with a demand the RPC cannot meet errors on its own key in the map,
naming the missing procedure (§4). The common case never meets that
check — commands annotate the full `Client`, and a procedure that does
not exist is an ordinary property error at the call site.

`ui/` reaches this file through `import type` only. A value import would
drag server code into the browser bundle; `bb plugin build` fails loudly,
and that failure is the enforcement.

One phase boundary runs through this file:

- `defineRPC` and `definePlugin` run at module load, pure and
  host-free; `defineRPC` throws on bad names (§3) the moment any
  test imports this file, and `definePlugin` adds only the two reserved
  command keys of its own (§4).
  `defineRPC` produces the value whose _type_ travels — `RPC` to
  `createRPC` in the browser (§5), `Client` to every CLI command (§4).
- The factory `definePlugin` returns runs when bb loads the plugin,
  because its other ingredients — `bb` and the assembled context — exist
  only then.

`defineRPC` does not fold into `definePlugin`, and the reason is
measured, not stylistic (ADR-0012): `RPC` and `Client` must derive
from a module-scope value, and deriving them from the `definePlugin`
result is circular — the plugin value contains the CLI commands, whose
`Client` annotations would resolve through the plugin value
again. tsc rejects the cycle outright, and the known workarounds hoist
the procedures back out, reinventing this split. The two type aliases
`RPC` and `Client` are scaffold-written once, self-updating through
`typeof rpc`, never touched by `add` (§7) — the price of breaking that
cycle. The module cycle the `Client` import closes (`cli/cat.ts` ↔
`server.ts`) is type-only on the command's side, fully erased at
runtime — plain `node server.ts` runs it clean (verified).

> Aside: the aliases were re-litigated before being kept. Inline
> `import()` types push a ~100-character annotation into every CLI unit;
> `import type { rpc }` plus `ClientFor<typeof rpc>` works but
> moves an import and a wrapper into every consumer; an app-side
> `Register` interface merge (the TanStack Router pattern) silently
> loses key-level dependency checking in any typecheck program that
> omits `server.ts` — exactly the browser-bundle case — and collides
> across two plugins compiled together. All verified in throwaway
> compile labs (tsc 5.9.3; the Register degradation on 7.0.2).

## 3. `./rpc`

### Procedures

```ts
// rpc/save-file.ts
import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import type { Context } from "../server/context.ts";

export const saveFile = defineMutation({
  input: z.object({ path: z.string(), content: z.string() }).strict(),
  output: z.object({ sha256: z.string() }).strict(),
  async handler(context: Context, input) {
    return context.repository.write(input.path, input.content);
  },
});
```

A procedure file has exactly one value export, named the camelization of
its filename (`check` fails on a mismatch, §7; `export type` is
unrestricted). Camelization is pinned like `snake` (below): split the
basename on `-`, uppercase the first letter of every segment after the
first, join — no acronym awareness, and a segment that starts with a
digit joins unchanged (`read-url.ts` → `readUrl`, never `readURL`;
`save-2fa.ts` → `save2fa`, _not_ lodash's `save2Fa`, whose extra
boundary would also change the derived wire name). The name is born at
the definition and travels by import
shorthand into the procedures key (§2) and from there into the wire name —
one compiler-checked chain. A default export would leave the file
anonymous and hand the naming to every import site; default exports
exist only where the host requires them: the `definePlugin` factory in
`server.ts` and the app in `ui/app.tsx` (§6).

`defineQuery` and `defineMutation` accept the same shape. The split says
what a reader needs — a Query reads, a Mutation writes; the TanStack/tRPC
pair, so "command" stays unambiguously CLI vocabulary — and carries
exactly one piece of metadata: the returned Procedure's `kind`
discriminant, `"query"` or `"mutation"`. It exists so §5's hook map can
hand a Query `useQuery` and a Mutation `useMutation`, and so the RPC
subtree's help (§4) can label each procedure `(query)` or `(mutation)`
— the only two things that branch on it.

Schemas are Standard Schema v1, object-constrained (ADR-0014): both
`input` and `output` must satisfy the vendored `JSONObjectSchema` type —
a schema whose parsed type extends `Record<string, unknown>`. A
procedure takes a JSON object and returns one, never a bare string,
number, or array: objects are the only shape that evolves by adding a
key, and the RPC subtree (§4) takes and prints exactly one object per
call. Optionality lives inside the object
(`z.object({ x: z.string().optional() })`), never on it — top-level
`.optional()` and `.nullable()` fail the constraint. Annotate schema
types with type aliases, not interfaces: an interface gets no implicit
index signature, so `z.ZodType<SomeInterface>` fails where the
equivalent type alias passes. A violation is a two-block TS2769 whose
first block names `JSONObjectSchema` (all verified against zod 4.4.3 on
tsc 5.9.3 and 7.0.2; the constraint structurally matches zod v4 — zod 3
users `import "zod/v4"`). The no-input convention below is exempt:
omitting `input` is absence, not a non-object input.

The handler's `input` parameter is the
schema's _output_ type; the return value is the output schema's _input_
type (async or not) — mirroring the host's own validation direction.

A handler that returns a literal-discriminated union needs an explicit
return annotation. Without one, the discriminant literals widen to
`string` in the inferred return
(`Promise<{ outcome: string; … } | { outcome: string; … }>`), the
handler matches neither overload, and the TS2769 misdirects: its "last
overload" block blames the _no-input_ overload's arity — "Target
signature provides too few arguments. Expected 2 or more, but got 1." —
when the real mismatch is the widened return type. Annotating the
handler `: Promise<Result>` restores contextual typing of the literals
and compiles clean (reproduced on tsc 7.0.2; dotfiles carries the fix in
`rpc/save-file.ts:13-16` and `rpc/remove-skill.ts:13`).

`input` is optional in the definition — but the _returned_ Procedure type
carries it required-or-absent, never optional. `defineQuery` and
`defineMutation` are two overloads: with `input`, the result type has a
required `input` member; without, the result type has no `input` member
at all. This is load-bearing, not style: a single signature whose result
keeps `input?:` optional silently drops every procedure into the
no-input Client arm, and input typechecking vanishes with no compile
error anywhere (proven on tsc 7.0.2 and 6.0.3, strict mode,
± `exactOptionalPropertyTypes`). The Procedure types declare `handler` in
method syntax so concrete procedures satisfy the RPC's `Record`
constraint.

A procedure without input: the handler takes only `context`, the Client
method takes no argument, and bb-kit registers a vendored no-input schema
with the host. That schema accepts `null` _and_ `undefined` — the SDK's
app hooks and fake host deliver `null` for a missing input, but the
server route leaves a truly empty POST body as `undefined`, and the
endpoint is public API (§6), so hand-crafted empty-body calls must pass
too.

> Aside: this replaces the branch's `noInput` singleton — the brand, the
> identity comparison, the required explicit `caller.overview(null)` at
> every call site, and the alias-detection rules all delete.

Procedures carry no `exampleInput` field — the fixtures subsystem it
fed is not being rebuilt (§9).

### Context

Handlers annotate their first parameter with a plugin-defined context
type. The convention is one `Context` assembled in `server/context.ts`
from the `BbPluginApi` plus the plugin's own services — that DI seam is
what makes tier-1 tests (§8) possible (ADR-0005). A file may narrow with
`Pick<Context, "repository">` for least privilege.

`RPCContext<RPC>` is the intersection of every handler's
annotation; `definePlugin` and `createClient` demand a value assignable
to it — `definePlugin` constrains its `context` callback's return, so
the error for a missing field lands on that entry. The intersection helper is one private function in one module, and
it filters an unannotated handler's `unknown` to `never` before
intersecting (`unknown extends C ? never : C`). The filter is
load-bearing: without it, one handler that omits the annotation — say,
one that returns static data and never touches context — absorbs the
whole intersection to `unknown`, and `definePlugin` silently accepts
anything. With no annotated handler at all, `RPCContext` degrades to
`{}` — the scaffold's first compile depends on that floor.

> Aside: the branch duplicated the intersection helper verbatim in two
> files.

### RPC and wire names

`defineRPC({ namespace, procedures })`:

- `namespace` must match `/^[a-z0-9][a-z0-9-]*$/` and equal the plugin
  id (`check` rule 2, §7).
- Keys must match `/^[a-z][a-zA-Z0-9]*$/`.
- Pattern violations throw at define time — a plain `Error`, as does the
  wire-name collision below. These are programming errors; nothing
  branches on them.

Each procedure's Wire name is derived `snake(namespace) + "_" +
snake(key)`, where `snake` maps `-` to `_`, inserts `_` between a
lower/digit and an upper, and lowercases. Those three clauses are
exhaustive — no other boundary inserts an underscore. Pinned examples:

- `("audit-log", "readEntry")` → `audit_log_read_entry`
- `("audit-log", "readURL")` → `audit_log_read_url`
- `("audit-log", "readURLPath")` → `audit_log_read_urlpath` — the
  acronym-then-word shape; _not_ lodash's `read_url_path`. Substituting a
  snake-case library silently changes public wire names.

The acronym shapes never arise by shorthand — camelization is
acronym-unaware (`read-url.ts` keys as `readUrl`) — but an explicit
entry (`{ readURL: readUrl }`) is legal (§7 rule 1 requires each entry
to resolve to a unit file, not to be spelled by shorthand), so `snake`
is pinned over the full key grammar.

Wire names are public API, unlocked, rename = breaking change (ADR-0008).
`defineRPC` throws at define time if two keys derive the same wire
name (`readUrl` / `readURL`).

There is exactly one derivation: the runtime `wireName(namespace, key)`
function. It lives in one internal module; `./rpc` re-exports it and
`./query` imports it directly — the Runs-in column in §1 describes
consumer import sites, not module reachability. `check` prints the
derived wire-name table.

> Aside: the branch maintained a second, type-level `SnakeCase` mirror so
> the contract type was keyed by wire names. The rewrite drops it: every
> consumer-facing type (Client, UI client) is keyed by procedure keys, so
> the mirror bought only editor-hover visibility at the price of two
> implementations that must never disagree.

The RPC value is `{ namespace, procedures }`, frozen at define time —
mutation between define and register is not a supported seam. The
`namespace` property is literal-typed; that literal is what `createRPC`'s
compile-time namespace check (§5) keys off.

### Client

```ts
type ClientFor<R> = {
  [K in keyof R["procedures"]]: R["procedures"][K] extends {
    input: infer In extends StandardSchemaV1;
    output: infer Out extends StandardSchemaV1;
  }
    ? (input: SchemaInput<In>) => Promise<SchemaOutput<Out>>
    : R["procedures"][K] extends { output: infer Out extends StandardSchemaV1 }
      ? () => Promise<SchemaOutput<Out>>
      : never;
};
```

`SchemaInput<S extends StandardSchemaV1>` and `SchemaOutput<S>` are the
schema's inferred input and output types — the vendored equivalents of
the SDK's `StandardSchemaV1InferInput`/`InferOutput`.

This exact formulation is the verified one: with `input`
required-or-absent on the Procedure types (above), the with-input arm
matches only procedures that declare input, a no-input procedure never
leaks into it, and the wire direction holds — the client takes the input
schema's _input_ type and receives the output schema's _output_ type.

One Client type, used identically on the server, in CLI commands, and in
the browser — and one set of semantics. `createClient(rpc, context)`
validates input against the schema before invoking the handler and
validates the result after, throwing `RPCValidationError` — `issues`
carries the Standard Schema issues, `stage` says `"input"` or
`"output"`. A CLI command exercising the Client hits exactly the
validation the wire would. The client is a plain object built over the
RPC's keys, no proxy — an unknown key is an ordinary missing property.

> Aside: the branch had two mirror-image types — `RpcCallerFor`
> (in-process, unvalidated, schema-output in / schema-input out) and
> `RpcClientFor` (wire, the reverse) — whose near-identical names invited
> mixups. Making the in-process caller validate is what lets one type,
> with one meaning, serve both sides.

`definePlugin`'s factory (§2) compiles the RPC into a single
`bb.rpc.register(contract, handlers)` call — wire-named keys, `{ input,
output }` per method, handlers closing over the assembled context — and
builds `createClient(rpc, context)` for the CLI commands, the RPC
subtree (§4), and `setup`.
The registered handlers invoke the procedure handlers directly: wire
validation is the host's, in-process validation the client's, so no call
is validated twice. `createClient` alone serves tier-1 tests.

## 4. `./cli`

### CLI commands

```ts
// cli/cat.ts
import { defineCommand } from "@bb-kit/core/cli";
import type { Client } from "../server.ts";

export const cat = defineCommand({
  summary: "Print a managed file",
  configure(command) {
    command.argument("<path>", "repo-relative path");
    command.option("--raw", "skip render hints");
  },
  async run(rpc: Client, { args, options, context }) {
    const file = await rpc.readFile({ path: args[0] });
    return { exitCode: 0, stdout: file.content };
  },
});
```

The export convention is §3's: one value export, the camelization of
the filename — `cli/cat.ts` exports `cat`, `cli/sync-all.ts` exports
`syncAll`.

`configure` (optional) receives a plain commander `Command` for
arguments, options, and help text. bb-kit installs the action itself
after `configure` runs — a user-supplied `.action()` is inert, and
`check` warns when it sees one.

> Aside: this replaces the branch's `CliCommand` subclass, whose
> `handle()` method silently produced "completed without a result"
> whenever someone used raw `.action()` instead.

`run(deps, invocation)` — the example names the first parameter `rpc`,
after what it holds — receives the parsed invocation: `args`
(positional values, strings under default parsers), `options`
(`command.opts()`), and `context` (bb's `{ cwd?, threadId?, projectId?,
signal? }`, the `CLIContext` type). It returns
`CLIResult = { exitCode, stdout?, stderr? }`.

The first parameter is annotated with the full `Client`, imported
`import type { Client } from "../server.ts"`. That import closes a
module cycle with `server.ts`, but it is type-only on the command's
side and erased at runtime (§2). A procedure the RPC lacks is then an
ordinary property error at the call site — `rpc.nope` is TS2339 in the
command's own file, not a distant composition error. A narrower
structural annotation — `Pick<Client, "readFile">` — stays legal for a
command that wants a minimal, cast-free fake in its unit test; nothing
scaffolds it. An unannotated parameter demands nothing and accepts any
client.

> Aside: the branch's separately hand-written `defineCLI<Dependencies>`
> generic deletes.

### Composition and execution

The composition surface is `definePlugin`'s `cli` entry (§2):
`{ summary, commands }`.

- There is no CLI name here: the CLI mounts as the RPC namespace —
  already validated by `defineRPC`, so the entry adds no define-time
  patterns of its own beyond the reserved keys below.
- Command names are the object keys (kebab). A single-word command keys
  by shorthand (`{ status, cat }`); a hyphenated one is quoted, valued
  by its camelized export (`{ "sync-all": syncAll }`).
- Commands are flat, one level, because bb's registration metadata is one
  level.
- `rpc` and `help` are reserved command keys — a define-time error and
  a `check` failure (§7): `rpc` is the subtree's mount point (below),
  and commander 13.1.0 both throws a cryptic plain `Error` on a
  duplicate subcommand and silently lets an explicit `help` shadow its
  implicit help (both verified).
- `definePlugin` constrains `commands` to
  `Record<string, CLICommand<ClientFor<R>>>`. A command hand-annotated
  with a demand the RPC cannot meet errors on its own key in the
  `commands` map, the chain naming the missing procedure — no branded
  helper needed (verified on tsc 5.9.3 and 7.0.2, identical
  diagnostics). The check is per-command, so one drifted command never
  obscures the others. One pin keeps it sound: `CLICommand` declares
  `run` as a function _property_ (`run: (rpc: D, …) => …`), never
  method syntax — method syntax makes the parameter bivariant, and a
  command demanding Client-plus-extra procedures then compiles
  silently. Only the type's syntax matters; command object literals
  still write `async run(…) {…}`.

The factory (§2) always makes the plugin's single
`bb.cli.register({ name, summary, commands, run })` call — `name` is the
namespace, and the RPC subtree (below) mounts with or without a `cli`
entry; absent one, the summary defaults to
`"RPC access for the <id> plugin"`. Command metadata (`{ name, summary, usage }`) comes from one
commander build at registration — `usage` is commander's own computed
usage string per subcommand. A `configure` that throws during this build
propagates out of the factory: the plugin does not load.

Each invocation then builds a fresh program with output captured to
strings and `exitOverride` on — `configure` therefore runs once at
registration and again on every invocation; a throw from it here lands
in the anything-else row below. Behavior:

| Invocation                    | Result                                |
| ----------------------------- | ------------------------------------- |
| empty argv                    | exit 2, help on stderr                |
| `--help` / `help`             | exit 0, help on stdout                |
| unknown command / parse error | exit 2, commander's message on stderr |
| `run` throws `CLIError`       | its `exitCode`, message on stderr     |
| anything else thrown          | exit 1, message on stderr             |

`CLIError` is `new CLIError(message, { exitCode = 1 })` — a message and
an exit code, nothing else; it carries no stdout. Output travels only
through `CLIResult` strings; the host caps combined output at 1 MiB.

Reserved names (`thread`, `plugin`, `status`, …) apply only to the
top-level CLI name — under `definePlugin`, the plugin id itself — never
to command keys (bb-kit's own `rpc`/`help` reservation above is
separate), so the scaffold's `cli/status.ts` is legal, while a
plugin _id_ colliding with a reserved name cannot mount a CLI at all,
subtree included.
The rule is the host's, enforced by the real policy in tier-2 tests —
the SDK's fake host shares `internal/host-policy` with production, so a
reserved name fails `npm test`, not the install; `check` catches it
statically first (§7).

`invokeCLI(commands, deps, argv, options?)` is the actual execution
path for curated commands, exported: the `run` dispatcher passed to
`bb.cli.register` delegates to it, and tests call it directly with a
fake client and the plain command map — no plugin value required. It
does not mount the RPC subtree: the subtree is framework behaviour,
tested once in the framework, not per plugin. `deps` is typed as the
intersection of the commands' declared dependencies (a
`UnionToIntersection` over the inferred `run` parameter types, in
non-inference position — verified): a full-`Client` command therefore
demands a full client, and a test faking only part of one writes
`as unknown as Client`, while a `Pick`-annotated command keeps its
minimal, cast-free fake. `options` is `{ context?, name?, summary? }`:
`context`
defaults to `{}` (a test whose command reads `context.cwd` passes one);
`name` and `summary` shape help output — the factory passes the real
ones, tests may omit them for placeholders.

### The RPC subtree

Every plugin CLI mounts `bb <id> rpc` — one subcommand per procedure,
`cli` entry or not (ADR-0013). It is the terminal face of the RPC,
built for the user who reads `--help` and speaks JSON natively — on
this host, usually an agent: uniform, object in, object out, no
curation required. Curated commands stay the place for human
ergonomics; the subtree is deliberately boring.

- Subcommand names kebab the procedure key: `readFile` → `read-file`,
  `readURL` → `read-url`. Post-kebab collisions coincide with
  wire-name collisions, which already throw at define time (§3). A
  procedure key that kebabs to `help` is a `check` failure (§7) — it
  would shadow the subtree's own help.
- Each subcommand takes one optional positional, which must parse to a
  JSON _object_ (ADR-0014) — a non-object is exit 1 before dispatch.
  Omitted, the client is invoked as for no input (§3): a no-input
  procedure accepts that; a with-input procedure reports its schema's
  issues. An object positional starts with `{`, so commander's
  leading-`-` caveat never arises.
- Success prints compact `JSON.stringify(result)` to stdout, exit 0.
  `RPCValidationError` issues, thrown handler messages, and malformed
  positional JSON go to stderr, exit 1. The host's 1 MiB combined cap
  applies as to any CLI output.
- Dispatch goes through the plugin's own validating Client (§3): both
  directions checked, exactly an in-process call.
- `bb <id> rpc --help` lists every procedure labelled `(query)` or
  `(mutation)` — the `kind` discriminant's second consumer (§3).
- The subtree is framework-owned: never a `commands` entry, never
  touched by `add`, not mounted by `invokeCLI`. Tier-2 tests reach it
  through the fake host like any registered CLI.

## 5. `./query`

```ts
// ui/rpc.ts — scaffolded; the only place in ui/ the namespace is written
import { createRPC } from "@bb-kit/core/query";
import type { RPC } from "../server.ts";

export const rpc = createRPC<RPC>("dotfiles");
```

```tsx
// ui/panel.tsx
import { useQueryClient } from "@tanstack/react-query";
import { rpc } from "./rpc.ts";

export function Panel() {
  const queryClient = useQueryClient();
  const overview = rpc.overview.useQuery();
  const save = rpc.saveFile.useMutation({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: rpc.overview.queryKey() }),
  });
  // save.mutate({ path: "…", content: "…" })
}
```

`createRPC<RPC>(namespace)` returns one hook bundle per procedure
key — the wagmi/tRPC pattern. A Query key carries `useQuery` and
`queryKey(input?)`; a Mutation key carries `useMutation(options?)`. Which
bundle a key gets is mapped off the Procedure's `kind` discriminant (§3),
so `useQuery` on a Mutation is a compile error.

`useQuery` wraps TanStack's: the query key is derived — `[namespace,
key]`, plus the input when the procedure takes one — and `options` is
TanStack's object minus `queryKey`/`queryFn`. The input-presence
overloads (§3) carry through: a no-input Query's `useQuery(options?)` has
no input parameter at all; a with-input Query's `useQuery(input,
options?)` requires it. `useMutation` binds `mutationFn` the same way and
types `mutate` from the input schema. Invalidation stays explicit in
`onSuccess`, addressed through `queryKey(input?)` — the same derivation
`useQuery` uses, so there is no hand-written key registry to go stale
(no `ui/keys.ts` exists).

The namespace still has to appear as a value exactly once in `ui/`. The
browser imports the RPC as a type only (§2), and the host gives a
plugin's own components no way to read their plugin id at runtime —
verified against SDK 0.4.6: `PluginSdkApp` has no id hook, `BbContext` is
only `{ projectId, threadId }`, and `pluginId` is delivered solely to
content scripts (the host _holds_ the id in a React context of its own,
but exports no hook for it). That one value is the scaffolded `ui/rpc.ts`
binding above; the parameter is typed as the RPC's namespace literal,
so a binding that disagrees with `server.ts` is a compile error.

The generated hooks call the SDK's `useRpc()` internally, at render time.
That is why this surface is hooks rather than a module-scope client: in
bb 0.38 `useRpc` is a `useMemo` over `callPluginRpc(fetch, pluginId,
method, input)` whose `pluginId` comes from host-internal React context,
so the client only exists inside render. `createRPC` itself is not a hook
and is safe at module scope — and for the same rules-of-hooks reason it
cannot be _named_ `useRPC`: a `use*`-named call at module top level is a
lint violation by convention.

For imperative call sites — event handlers, prefetching —
`rpc.useClient()` is the escape hatch: a hook yielding
`ClientFor<RPC>`, the same type as the server-side Client.

At runtime every path is one proxy over `call(wireName(namespace, key),
input)`; a no-input method calls with `null`, matching the SDK hooks' own
`input ?? null` serialization. Unlike the server client (§3), the proxy
necessarily forwards _any_ key to the wire — the RPC exists here as a
type only — so a typo the type system misses becomes a wire call to a
nonexistent method.

`PluginQueryBoundary` wraps a plugin's component tree in a
`QueryClientProvider` owning one lazily created `QueryClient` per mount
(cleared on unmount; `client` prop overrides ownership). It exists
because the host does not shim `@tanstack/react-query` — the plugin
bundles its own copy with its own cache, and no host provider will be
there.

TanStack stays reachable underneath: `PluginQueryBoundary` is an ordinary
provider, and `useQueryClient`, `rpc.<key>.queryKey`, and
`rpc.useClient()` compose with any hand-written `useQuery`.

> Aside: the old kit's `operationQueryOptions` /
> `operationMutationOptions` builders (with mandatory `invalidate`) hung
> off runtime operation descriptors in the browser and still left query
> keys hand-rolled. An earlier draft of this section chose bare TanStack
> calls over "a second API over the first"; the hooks above supersede
> that judgment because they delete the hand-maintained key registry —
> the one piece of the bare convention that could silently go stale — and
> follow the shape wagmi and tRPC have made the ecosystem default.

There is no realtime subpath. TanStack is the only owner of server
state in a plugin UI; if realtime ever ships, it ships
invalidation-only — realtime data is never authoritative.

> Aside: the branch's `useRealtimeInvalidation` had zero consumers, and
> with the subpath goes its "Authoritative query" / "Signal"
> vocabulary — with one owner of server state, the contrast the terms
> drew is gone.

## 6. The host seam

What bb-kit compiles down to, per the verified bb 0.38 contract:

| bb-kit                             | Host call                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definePlugin` factory, `rpc` half | one `bb.rpc.register(contract, handlers)` — wire-named methods, Standard Schema `{ input, output }`, served at `POST /api/v1/plugins/<id>/rpc/<method>`                                                                                                                                                                    |
| `definePlugin` factory, `cli` half | one `bb.cli.register({ name, summary, commands, run })` — `name` is the RPC namespace; always called, so the RPC subtree (§4) mounts even without a `cli` entry                                                                                                                                                            |
| `ui/app.tsx` default export        | `definePluginApp(setup)` from `@get-bb/plugin-sdk/app`, bundled by `bb plugin build` when `bb.app` is declared                                                                                                                                                                                                             |
| `bb-kit create` manifest           | `package.json` with the `bb` section: `{ name, description, server: "./server.ts", app: "./ui/app.tsx", branding: { icon: "./assets/icon.svg" }, skills: [] }` — `branding` is required by the host's manifest schema (an `icon` or `logo.light`, plugin-owned paths must be `.svg`), so `create` ships a placeholder icon |

The app entry is entirely the SDK's contract; bb-kit adds nothing to it.
The default export must be the branded object from
`definePluginApp((app) => { ... })`; everything the UI contributes
registers inside that setup function via `app.slots.*` (`navPanel`,
`homepageSection`, `settingsSection`, …), and the host re-runs setup per
generation, replacing registrations wholesale. The scaffold registers one
`navPanel`:

```tsx
// ui/app.tsx
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { Panel } from "./panel.tsx";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "main",
    title: "Dotfiles",
    icon: "Folder",
    path: "dotfiles",
    component: Panel,
  });
});
```

`bb plugin build` never bundles `@get-bb/plugin-sdk/app`, react, or the
other host-singleton packages — it swaps them for shims reading
`globalThis.__bbPluginRuntime`, which the bb app installs before
importing the bundle. `@tanstack/react-query` is not on that shim list,
which is the whole reason `PluginQueryBoundary` exists (§5).

bb-kit never imports `@get-bb/plugin-sdk` in its `./plugin`, `./rpc`,
and `./cli` type surface. The `bb` the factory receives — and hands to
`context` and `setup` — is a _structural_ type — just the
`rpc.register` / `cli.register` method shapes — that the real
`BbPluginApi` satisfies. `definePlugin` declares `context` and `setup`
in method syntax (the same variance device as §3's handlers), so a
plugin-side callback annotated with the full `BbPluginApi` — the
scaffolded `server/context.ts` — is accepted against the narrower seam.
Rationale: the SDK is
pre-1.0 and exact-pinned per plugin; if bb-kit's emitted declarations
named SDK types, every SDK minor could break type-compat between bb-kit
and its consumers.

The cast-free seam is verified, not hoped for: against the SDK 0.4.6
declarations verbatim, a `BbPluginApi`-shaped value assigns to the
structural seam and bb-kit's calls through it typecheck — strict mode,
with and without `exactOptionalPropertyTypes`, on tsc 7.0.2 and 6.0.3, in
both method and property syntax. Should a future SDK signature change
break that, the cast lives in exactly one place inside `definePlugin`'s
registration code — never in plugin code.

> Aside: both the old kit and the branch reached the same conclusion via
> `register: unknown`; the rewrite types the seam precisely instead of
> punching a hole.

The factory registers everything before it resolves — context assembly
(awaited when async), the `rpc.register` and `cli.register` calls, then
`setup`. The host accepts late registration (its liveness check only
trips when a load _fails_), but `definePlugin` owns the factory, so
registration cannot drift into timers or request handlers unless
`setup` puts it there. Second `rpc.register` of the same method, second
`cli.register`, or a malformed name throws whenever it happens — at load
under this discipline, and identically in tier-2 tests, because the fake
host shares the production policy module.

## 7. The `bb-kit` bin

Three commands (ADR-0009, ADR-0010). All output is plain text with
file:line references. `check` has exactly two diagnostic levels: failures
exit non-zero, warnings print and never affect the exit code. An
unparseable file, or a missing toolchain (the plugin's `typescript` or
SDK not installed), is itself a failure reported with file:line; analyses
that depend on it are skipped.

### `create`

Scaffolds the tree in `docs/bb-kit-dev-workflow.md` — a working plugin,
not a stub. What it writes:

- The manifest as in §6, branding included, with the placeholder
  `assets/icon.svg`.
- A `README.md` that teaches the tag-and-install release flow (ADR-0011).
- `scripts.test = "node --test --import tsx"` and
  `scripts.typecheck = "tsc"`; engines matching the pinned SDK.
- One working Query, one CLI command, and `ui/app.tsx`, with tests at
  every tier: the sibling tier-1 tests, a tier-2 test running the
  default-export factory, and the tier-3 render test.
- A `tsconfig.json`, because the scaffold's `.ts`-suffixed relative
  imports do not typecheck without one: `module: "nodenext"`,
  `allowImportingTsExtensions: true` with `noEmit: true` — true to life,
  since a plugin never emits (bb loads `server.ts` from source, tests run
  through the tsx loader, `bb plugin build` bundles the UI; ADR-0011
  forbids a committed `dist/`) — plus `strict`, `erasableSyntaxOnly`,
  `verbatimModuleSyntax` (ADR-0006's discipline, enforced where it
  bites) and `jsx: "react-jsx"` for `ui/`.
  `rewriteRelativeImportExtensions` is deliberately absent: it exists to
  rewrite `.ts` to `.js` at emit, and nothing here emits.
  `scripts.typecheck` is what verifies these flags — without it the
  tsconfig is honored by editors but checked nowhere; `check` still
  never typechecks (the out-of-scope clause below).
- Dependencies: runtime `zod` and `@bb-kit/core` — the framework is a
  runtime dependency of a plugin, never a dev one, because bb loads
  plugin source in place and the framework imports resolve at run time;
  devDependencies, exact-pinned:
  `@get-bb/plugin-sdk`, `typescript`, `tsx`, `jsdom`,
  `react`, `react-dom`, `@tanstack/react-query`,
  `@testing-library/react`, `better-sqlite3`, `hono`, `cron-parser` —
  the last three because `createFakePluginHost` imports them at module
  top level, so tier-2 tests hard-require them.

The package name must derive to the intended plugin id. `derivePluginID`
is vendored (the SDK does not export it): strip the npm scope, strip a
leading `bb-plugin-` prefix (case-sensitive, before lowercasing),
lowercase, map every character outside `[a-z0-9-]` to `-`, trim leading
and trailing `-`, error if nothing remains. `create` prints the derived
id.

### `add query|mutation|command <name>`

`<name>` must be kebab-case (`/^[a-z][a-z0-9-]*$/`); anything else is
rejected. Writes `rpc/<name>.ts` + `rpc/<name>.test.ts` (or `cli/…`) from
templates — the unit declared `export const <camel(name)> = …` (§3) —
then prints the exact wiring lines: the named import and the key. For a
procedure the key is the import shorthand itself, plus the derived wire
name; for a CLI command the key is `<name>` verbatim — quoted and valued
by the camelized export when `<name>` is hyphenated (§4).

`add` never edits an existing file, never overwrites, never touches
`server.ts` (ADR-0009). Until the author pastes the wiring, `check`
fails.

### `check`

Static analysis only: parses with the plugin's own `typescript`, resolves
policy from the plugin's own SDK, executes nothing.

1. Wiring is bijective: every non-test file in `rpc/` and `cli/` is
   imported and keyed in `server.ts`, and every procedures/commands entry
   resolves to such a file. Each such file has a kebab basename
   (`add`'s `/^[a-z][a-z0-9-]*$/`; a violation is a failure, keeping
   camelization total over everything this rule judges) and exactly one
   value export, named the camelization of its filename (§3);
   `export type` is unrestricted. A `commands` key must equal the kebab
   basename of the file it resolves to — the guard behind §2's
   quoted-key exception; procedure keys are not so pinned (§3's
   explicit-entry clause).
2. The RPC namespace equals `derivePluginID(package.json name)`.
3. No two procedure keys derive the same wire name (also thrown at
   runtime by `defineRPC`); prints the full wire-name table.
4. Manifest sanity: `bb.server` / `bb.app` / branding / theme / skills
   paths exist, are relative, stay inside the package, and do not point
   at build output; `engines` values are valid semver ranges.
5. Composition: the default export is a single `definePlugin` call, with
   a `cli` entry when `cli/` contains command files; the CLI name — the
   plugin id — matches the SDK's policy pattern and is not reserved
   (both resolved from the plugin's own SDK's `internal/host-policy` —
   the §1 clause); commands are flat; no `commands` key is `rpc` or
   `help`, and no procedure key kebabs to `help` (§4). Warns on
   `.action(` inside a `configure` body.
6. Warns on a missing sibling test beside any non-test file in `rpc/` or
   `cli/` — warn-only because the one-file-one-test layout is bb-kit's
   own doctrine (ADR-0007) while test policy is otherwise the plugin's
   business (ADR-0009).

Out of scope forever: lint, typecheck, running tests, workspace policy —
those are the plugin's own scripts and the consuming repo's business.

## 8. Test tiers

How the three tiers (ADR-0005) map onto this API:

| Tier           | Harness                                             | bb-kit involvement                                                                                                                                                                                                                           |
| -------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 unit         | none                                                | call a handler directly, or `createClient(rpc, fakeContext)`; CLI via `invokeCLI({ cat }, fakeClient, argv)` — a full-`Client` command takes a full fake (or `as unknown as Client`); a `Pick`-annotated one keeps a minimal, cast-free fake |
| 2 integration  | `@get-bb/plugin-sdk/testing` `createFakePluginHost` | run the default-export factory against the fake host; invoke registered RPC/CLI through it                                                                                                                                                   |
| 3 UI component | `@get-bb/plugin-sdk/testing/app` under jsdom        | `installDom()` first, then `loadPluginApp` + `renderSlot`                                                                                                                                                                                    |

`installDom()` is `./testing`'s only export: idempotent, installs jsdom
globals (`window`, `document`, …) onto `globalThis`, and fails with a
clear message naming the `jsdom` devDependency if it cannot resolve it.
The SDK's `renderSlot` assumes a DOM exists and provides none (its own
docs assume a vitest jsdom environment; under `node --test` this call is
the equivalent).

Tier-3 order matters and the scaffolded test encodes it: `installDom()`
first, then `loadPluginApp(() => import("../ui/app.tsx"))` — the thunk
form is required because the SDK's app facade binds
`globalThis.__bbPluginRuntime` at import time — then
`renderSlot(captured.navPanels[0], props, { rpc })`. `renderSlot`'s rpc
handlers are keyed by wire names (they fake the wire, not the RPC),
which is fine: wire names are public API and `bb-kit check` prints the
table.

Tier 3 cannot reproduce StrictMode _effects_. React 19 grants strict
effects — the dev double mount — only when `<StrictMode>` is the root of
the render, and `renderSlot` always nests the component under its
providers, so it only double-renders (verified against react 19.2.8 and
SDK 0.4.8, `dist/testing/app.js:1190`). bb's app root does wrap every
panel in root-level StrictMode, so a mount/cleanup pairing can pass
every renderSlot test and still break in the app — commit `d41a72f`
fixed exactly such a shipped bug. Double-mount-sensitive behavior needs
an RTL-direct test with root-level `<StrictMode>`; the precedent is
`query.test.ts`'s "an owned client survives a StrictMode double mount".

All three tiers run under plain `node`. Per ADR-0006, the consuming
repo's CI must exercise exactly that published-consumer path — even
where, as in bb-plugins itself, the repo's own dev loop uses Bun.
The bin itself is node-only too: TS 7's sync API reads a Node stdout
internal absent in Bun, so the bin refuses under bun with one line and
exit 1 — a bun repo's scripts must invoke it through `node`.

## 9. Not being rebuilt

Each cut names its scar (decisions in ADRs 0002, 0008, 0009):

- **Project lock file** (`bb-kit.lock.json`) — wire names are derived and
  public; there is nothing to pin (ADR-0008).
- **Generated catalogs** and byte-exact staleness checks — the RPC in
  `server.ts` is hand-wired; nothing is generated to drift.
- **ts-morph / jsonc-parser editing of user source** — generators never
  edit (ADR-0009).
- **Fixtures/evals subsystem** — even dotfiles never used it. With it
  goes mandatory `exampleInput`.
- **Operation identity (`module.operation`) and `OperationRisk`** — the
  Procedure key plus derivation is the whole identity; risk labels
  informed nothing.
- **`verify` five-step gate, `doctor`, BBK000–406 diagnostic taxonomy,
  import-architecture checks** — build/lint/test policy belongs to the
  plugin's scripts; `check` reports in prose.
- **Compatibility contract machinery** (pinned host shims, registry URL,
  `compatibility inspect|check|upgrade`) — engines pins plus
  install-time compilation (ADR-0011) replace it.
- **`noInput` brand and explicit `null` call arguments** — optional
  `input` (§3).
- **Type-level wire-name derivation** — single runtime derivation (§3).
- **`./realtime` and `./standard-schema` subpaths** — no consumers; types
  re-exported from `./rpc` instead.
- **Query/mutation option builders with mandatory invalidation** — the
  derived-key hooks (§5).
- **`bb-kit dev`** — the inner loop is `npm test -- --watch`; the live
  loop is bb's own `bb plugin dev` (ADR-0010).

## 10. Deltas from the reconsider branch

The branch (`bb/reconsider-bb-kit-plugin-directory-thr_ss2vds65gf`) is an
idea mine, not a source (ADR-0001). What the rewrite changes against it:

| Branch                                                      | Rewrite                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `.` export aliases `./rpc`                                  | no root export                                                            |
| `noInput` branded singleton, callers pass `null`            | optional `input`, zero-arg callers                                        |
| dual type-level + runtime wire derivation                   | runtime derivation only                                                   |
| `RpcCallerFor` vs `RpcClientFor` mirror types               | one validated `ClientFor`, both sides                                     |
| unvalidated in-process caller                               | client validates input and output                                         |
| `CliCommand extends Command` + `handle()`                   | plain `configure` + `run`, bb-kit owns the action                         |
| hand-annotated `defineCLI<Dependencies>`                    | commands take the full `Client`; a missing procedure is a call-site error |
| `RpcHost.register: unknown`                                 | precise structural host types                                             |
| duplicated intersection helper                              | one private helper                                                        |
| `defineRpcRouter` / per-file+composed `defineCLI` overloads | `defineRPC`; `defineCommand` (file); `definePlugin` (composition)         |
| hand-written `plugin(bb)` factory wiring register calls     | `definePlugin` returns the factory; wiring is data                        |
