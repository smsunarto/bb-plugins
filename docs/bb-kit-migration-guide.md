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
2. Split `server.ts` into the composition root, `server/context.ts`, and
   registrar modules. Extract each procedure into `rpc/` and each command
   into `cli/`.
3. Update `package.json` and `tsconfig.json`.
4. Hunt CLI regressions (see below). This step finds real bugs.
5. Run every gate. Commit the migration as one commit.

## Baseline costs

Every migration pays these, regardless of plugin size:

- `dependencies`: add `"@bb-kit/core": "0.1.0"`. `devDependencies`: add
  `tsx` (pinned). Run `bun install`. Expect unrelated lockfile churn —
  bun prunes stale entries while it is in there. Commit `bun.lock` with
  the migration, since the dep edit caused it.
- Test runner: `node --test --import tsx` replaces
  `--experimental-strip-types`, because plugin code now imports bb-kit's
  TS source across the workspace. Tests move from `test/` to sibling
  `<unit>.test.ts` files, which node's default discovery finds.
- `tsconfig.json` `include` gains `"rpc", "cli"`.
- `files` in `package.json` swaps root helpers for `"server/"`, `"rpc/"`,
  `"cli/"`. Check the pack afterwards: `bun pm pack --dry-run` must ship
  no test files and no root helpers.
- Scripts: add `lint`, `check`, `verify` (copy them from notify or
  dotfiles). The checker runs from source:
  `node --import tsx ../../packages/bb-kit/src/bin.ts check`.
  Never run the checker under bun — TS7's sync API reads a stream handle
  bun does not provide.

## The shape the checker enforces

- `server.ts` is the composition root only. It exports `rpc`
  (the `defineRPC` result), `type RPC`, `type Client = ClientFor<RPC>`,
  and a default `definePlugin({ rpc, cli, context, setup })`.
- `rpc/` and `cli/` hold one unit per file. Kebab-case basename, exactly
  one value export named the camelCase of the basename. `export type` is
  free. No helper files as direct children — the checker treats every
  direct child as a unit, so helpers live under `server/`.
- A unit name that collides with an import gets an alias in `server.ts`
  (`import { send as sendCommand } from "./cli/send.ts"`). Aliased
  imports are legal.
- CLI `commands` keys must equal each unit's kebab basename, one-to-one.
- The `namespace` must equal what `derivePluginID` computes from the
  package name. The checker prints the resulting wire names — read them
  and check each against the released contract before committing.
- Per-procedure zod schemas stay module-private inside their unit.
  Anything shared across units goes in a `server/` module.

## The context split

The old `server.ts` closure state becomes `server/context.ts`: one
exported `Context` type plus `createContext(bb: BbPluginApi)`. The
`(bb: BbPluginApi)` annotation on `context` and `setup` is the supported
escape hatch — method-syntax bivariance lets it through, and it gives
the factory the full SDK surface.

Two rules the notify review enforced:

- Settings reads stay live. Export `settings: () => current` where
  `current` is the mutable binding an `onChange` handler updates. Never
  hand out a snapshot.
- Every concurrency invariant of the old closure must survive the move
  verbatim: settle-exactly-once waiters, reserve-then-rollback dedupe,
  delete-first LRU, dispose order. Diff the new context against the old
  server.ts function by function, not by skimming.

Registrars (`server/routes.ts`, `server/events.ts`,
`server/agent-tool.ts`) take `(bb, context)` and only map their surface
onto context methods. Constants module-private to one surface move with
that surface. Shared constants export from `server/context.ts`.

Write a `server/fake-context.ts` test double: all-green defaults, a
`posts` recorder, `Partial<Context>` overrides. RPC unit tests run
against it. CLI unit tests use `invokeCLI` plus `stubClient` from
`@bb-kit/core/testing` and never touch the context.

## CLI gets only the client

`defineCommand`'s `run` receives the RPC client and the invocation, not
the server context. Any command behavior that read server internals must
become a procedure first. Notify's commands already sat on `send` and
`status`, so this cost nothing — budget for it when the old CLI reached
into state directly.

## Commander replaces the hand parser — hunt this regression class

The one class that produced every real finding: **a previously valid
invocation now fails or behaves differently**. Before migrating, list
every invocation the old parser accepted, including the awkward ones.
Test each against the new command. Notify shipped three regressions into
review, and all three were caught only by this hunt:

- Blank-message validation vanished. A whitespace-only message would
  have posted an empty notification. Fix: `z.string().trim().min(1)` on
  the wire, plus a trim-and-reject in the command.
- The `--message <text>` flag was dropped because the design only
  remembered the positional. Fix: restore the option, positional wins.
- Unquoted multi-word messages broke. The old parser joined positionals
  (`bb notify send build is done` posted "build is done"). A plain
  `.argument("[message]")` takes one word and commander rejects the
  rest. Fix: a variadic argument, then flatten:

  ```ts
  command.argument("[message...]", "notification text");
  // commander delivers the variadic as one nested array in args
  const message = (args.flat().join(" ") || messageFlag || "").trim();
  ```

Divergences we accepted rather than fought, and would accept again:

- Usage and parse errors carry commander's wording. Exit codes stay 2.
- `send -x` (a single-dash token as the message) is now rejected.
  Restoring it needs `allowUnknownOption`, which breaks `--title`.
- `--message=hi` now works. Bonus, not a regression.
- Excess arguments after a no-argument command now error.
- The `rpc` subtree (`bb <plugin> rpc <wire-name>`) is always mounted.

Document each accepted divergence in the migration commit message.

## What must stay byte-identical

- Wire names. They are the released contract. The checker prints them.
- Success stdout of every command, line for line.
- HTTP routes, event handling, agent tool registration, the settings
  block, and dispose order — the app window and BB depend on them.
- Constants and their values. Record them in the plugin's `AGENTS.md` so
  the next agent does not "tidy" them.

## Gates

Run all of them yourself from the plugin directory. Subagent green runs
are claims, not evidence.

```
bunx oxfmt . && bunx oxlint . && bunx tsc --noEmit && bun run test
node --import tsx ../../packages/bb-kit/src/bin.ts check
bb plugin build .
bun pm pack --dry-run
```

## Release coupling

Once the plugin depends on `@bb-kit/core`, its next release requires
`@bb-kit/core` on npm first. Do not add a changeset for the migrated
plugin until the framework is published — a release PR that includes it
would fail to install.
