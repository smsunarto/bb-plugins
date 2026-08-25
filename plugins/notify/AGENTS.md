# Notify plugin conventions

Built on `@bb-kit/core` (subpath imports: `/plugin`, `/rpc`, `/rpc/query`, `/cli`, `/testing`).

## Layout

* `server/server.ts` is the composition root. The default export is
  a `definePlugin(...)` call whose `rpc` entry is the `{ send, status }` object
  literal. Commands take `Context` from `@bb-kit/core/plugin` and call RPC
  `.handler(context[, input])`. A Command that needs host invocation facts
  annotates `CommandContext<Context>` and reads `context.cli`.
* Process state lives under `server/` beside that file: `delivery.ts` (queue + waiters, interned by the host),
  `run-tracker.ts`, `project-names.ts`, `notify-thread.ts` (product rule, not
  an RPC), `routes.ts`, `events.ts`, `agent-tool.ts`, and the helpers
  `format.ts`, `lifecycle.ts`, `queue.ts`, `sound.ts`, `settings.ts`.
* `server/rpc/` and `server/cli/` hold one unit per file: kebab-case basename, exactly one value
  export named the camelCase of the basename. No helper files directly in either
  directory — the checker treats every direct child as a unit. Per-RPC
  schemas live module-private inside their unit; `export type` is unrestricted.
* `app/app.tsx` is the window app.

## Tests and checks

* Tests are sibling `<unit>.test.ts` files, run by `node --test --import tsx`
  (`bun run test`).
* `bun run check` runs the `@bb-kit/core` checker from source.
* Run `bun run typecheck` while editing and `bun run verify` before handoff.

## RPC names

The two RPC names are a public contract and must survive byte-identical:
`send`, `status`. Do not rename them.

## Behavior contracts

* HTTP routes `/pending`, `/ack`, `/open`, the thread events, the `notify_user`
  agent tool, the settings block, and the dispose order must stay byte-identical
  to the app's expectations. `app/app.tsx` polls `/pending` and acks `/ack`.
  `/pending` is `delivery.nextBatch`: mark, lease, hold, abort, retry. Enqueue
  wakes waiters in-process (0ms). Dispose: release polls, clear maps, await sound.
* Constants: BODY\_MAX\_CHARS 160 (`server/format.ts`), POLL\_HOLD\_MS
  25000 and RENDERER\_TTL\_MS 40000 (`server/delivery.ts`), DEDUPE\_WINDOW\_MS 3000
  and MAX\_TRACKED\_THREADS 500 (`server/run-tracker.ts`), PROJECT\_NAME\_TTL\_MS
  300000 (`server/project-names.ts`).
