# Migrating a plugin onto @bb-kit/core

This guide comes from the notify migration (commits `53d0821` and `6d62678`).
Notify was the first plugin migrated that bb-kit was not designed against:
a 514-line hand-rolled `server.ts` with its own RPC dispatch, CLI parser,
three HTTP routes, five event handlers, and an agent tool. The migration
replaced 517 lines with 1,197 across 28 files. Most of the growth is tests
and per-unit files, not new behavior. Read this before migrating the next
plugin, and follow the same order.

## Order of work

1. Move helpers and their tests under `server/` in a commit of its own.
   The move commit keeps the migration diff readable.
2. Split the old root `server.ts` into `server/server.ts` (composition root) and
   registrar modules. Extract each RPC into `server/rpc/` and each command
   into `server/cli/`. Handlers import `Context` from `@bb-kit/core/plugin`.
3. Update `package.json` and `tsconfig.json`.
4. Hunt CLI regressions (see below). This step finds real bugs.
5. Run every gate. Commit the migration as one commit.

## Baseline costs

Every migration pays these, regardless of plugin size:

* `dependencies`: add `"@bb-kit/core": "0.1.0"`. `devDependencies`: add
  `tsx` (pinned). Run `bun install`. Expect unrelated lockfile churn —
  bun prunes stale entries while it is in there. Commit `bun.lock` with
  the migration, since the dep edit caused it.
* Test runner: `node --test --import tsx` replaces
  `--experimental-strip-types`, because plugin code now imports bb-kit's
  TS source across the workspace. Tests move from `test/` to sibling
  `<unit>.test.ts` files, which node's default discovery finds.
* `tsconfig.json` `include` covers `"app"` and `"server"` (units live under `server/`).
* `files` in `package.json` swaps root helpers for `"server/"`, `"app/"`. Check the pack afterwards: `bun pm pack --dry-run` must ship
  no test files and no root helpers.
* Scripts: add `lint`, `check`, `verify` (copy them from notify or
  dotfiles). The checker runs from source:
  `node --import tsx ../../packages/bb-kit-core/src/bin/bin.ts check`.
  The checker parses in-process with the plugin's own TypeScript
  (ADR-0018), so bun can run it too — node stays the documented path
  (ADR-0006). A tsconfig that does not load — broken JSON or a
  config-level error such as a bad `extends` — now fails check, where
  the TS7 checker silently recovered.

## The shape the checker enforces

* `server/server.ts` is the composition root only. It default-exports
  `definePlugin({ pluginId, rpc, cli, setup })`. The RPC map
  is the `rpc` entry. The return carries `.rpc`. There is no
  `export const rpc` or `export type RPC`.
* `server/rpc/` and `server/cli/` hold one unit per file. Kebab-case basename, exactly
  one value export named the camelCase of the basename. `export type` is
  free. No helper files as direct children — the checker treats every
  direct child as a unit, so helpers live as siblings of the composition root.
* A unit name that collides with an import gets an alias in `server/server.ts`
  (`import { send as sendCommand } from "./cli/send.ts"`). Aliased
  imports are legal.
* CLI `commands` keys must equal each unit's kebab basename, one-to-one.
* The `definePlugin` `pluginId` must equal what `derivePluginID` computes from
  the package name. The checker prints the RPC names — read them and
  check each against the released contract before committing.
* Per-RPC zod schemas stay module-private inside their unit.
  Anything shared across units goes in a `server/` module.

## The context split

Do not move the old `server.ts` closure onto Context. Context is the
frozen host preset `{ bb }` from `@bb-kit/core/plugin`.
`bb` is `BbPluginApi`. Do not alias it in the plugin.

Product logic lives in RPC units, or in `server/` modules those units
and the event/route adapters call. Process state (git, a
queue, waiters, a run tracker) is interned by `bb`, never declared as
a Context field. A handler that names `git` or `notifyThread`
on its first parameter is a type error at `definePlugin`.

Settings stay live: `setup` calls `bb.settings.define` once, binds a
reader interned by `bb`, and `onChange` updates that reader.
Handlers call the reader; they do not snapshot.

Concurrency invariants of the old closure must survive: settle-exactly-
once waiters, reserve-then-rollback dedupe, delete-first LRU, dispose
order (release polls, clear maps, await sound).

Registrars (`server/routes.ts`, `server/events.ts`,
`server/agent-tool.ts`) take `bb` and map host surfaces onto those
modules. They are not a second business layer.

Tier-1 tests stub `bb` through `stubHostContext`
and bind fakes onto the same intern keys production uses
(`provideFakeGit`, `bindSettings`). CLI tests call
`command.invoke(context, argv)` with that stub.

## CLI gets CommandContext

`defineCommand`'s `run` receives `CommandContext<Context>`: the plugin
Context plus required `cli`. Commands call `.handler(context[, input])`
on RPC units. The extra `cli` property is type-level only. The
validating client remains on the `rpc` subtree. Do not
import `Client` from the composition root into `server/cli/`. CLI unit tests call
`command.invoke(context, argv, { cli })`.

## Commander replaces the hand parser — hunt this regression class

The one class that produced every real finding: **a previously valid
invocation now fails or behaves differently**. Before migrating, list
every invocation the old parser accepted, including the awkward ones.
Test each against the new command. Notify shipped three regressions into
review, and all three were caught only by this hunt:

* Blank-message validation vanished. A whitespace-only message would
  have posted an empty notification. Fix: `z.string().trim().min(1)` on
  the wire, plus a trim-and-reject in the command.
* The `--message <text>` flag was dropped because the design only
  remembered the positional. Fix: restore the option, positional wins.
* Unquoted multi-word messages broke. The old parser joined positionals
  (`bb notify send build is done` posted "build is done"). A plain
  `.argument("[message]")` takes one word and commander rejects the
  rest. Fix: a variadic argument, then flatten:

  ```ts
  command.argument("[message...]", "notification text");
  // commander delivers the variadic as one nested array in args
  const message = (args.flat().join(" ") || messageFlag || "").trim();
  ```

Divergences we accepted rather than fought, and would accept again:

* Usage and parse errors carry commander's wording. Exit codes stay 2.
* `send -x` (a single-dash token as the message) is now rejected.
  Restoring it needs `allowUnknownOption`, which breaks `--title`.
* `--message=hi` now works. Bonus, not a regression.
* Excess arguments after a no-argument command now error.
* The `rpc` subtree (`bb <plugin> rpc <name>`) is always mounted.

Document each accepted divergence in the migration commit message.

## What must stay byte-identical

* RPC names. They are the released contract. The checker prints them.
* Success stdout of every command, line for line.
* HTTP routes, event handling, agent tool registration, the settings
  block, and dispose order — the app window and BB depend on them.
* Constants and their values. Record them in the plugin's `AGENTS.md` so
  the next agent does not "tidy" them.

## Gates

Run all of them yourself from the plugin directory. Subagent green runs
are claims, not evidence.

```
bunx oxfmt . && bunx oxlint . && bunx tsc --noEmit && bun run test
node --import tsx ../../packages/bb-kit-core/src/bin/bin.ts check
bb plugin build .
bun pm pack --dry-run
```

## Release coupling

Once the plugin depends on `@bb-kit/core`, its next release requires
`@bb-kit/core` on npm first. Do not add a changeset for the migrated
plugin until the framework is published — a release PR that includes it
would fail to install.
