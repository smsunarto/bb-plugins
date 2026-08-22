# Notify plugin conventions

Built on `@bb-kit/core` (subpath imports: `/plugin`, `/rpc`, `/rpc/query`, `/cli`, `/testing`).

## Layout

- `server.ts` at the plugin root is the composition root. It exports `rpc` (the
  `defineRPC` result), `type RPC`, `type Client`, and a default `definePlugin(...)`.
- `server/` holds the runtime: `context.ts` (settings, queue, dedupe, post),
  `fake-context.ts` (test double), `routes.ts`, `events.ts`, `agent-tool.ts`,
  and the helpers `format.ts`, `lifecycle.ts`, `queue.ts`, `sound.ts`.
- `rpc/` and `cli/` hold one unit per file: kebab-case basename, exactly one value
  export named the camelCase of the basename. No helper files directly in either
  directory — the checker treats every direct child as a unit. Per-procedure
  schemas live module-private inside their unit; `export type` is unrestricted.
- `app.tsx` at the root is the window app.

## Tests and checks

- Tests are sibling `<unit>.test.ts` files, run by `node --test --import tsx`
  (`bun run test`).
- `bun run check` runs the `@bb-kit/core` checker from source.
- Run `bun run typecheck` while editing and `bun run verify` before handoff.

## Wire names

The two RPC wire names are a public contract and must survive byte-identical:
`notify_send`, `notify_status`. They derive from namespace `notify` plus the
procedure keys `send`, `status` — do not rename either side.

## Behavior contracts

- HTTP routes `/pending`, `/ack`, `/open`, the thread events, the `notify_user`
  agent tool, the settings block, and the dispose order must stay byte-identical
  to the app's expectations. `app.tsx` polls `/pending` and acks `/ack`.
- Constants: BODY_MAX_CHARS 160 (exported by `server/context.ts`), POLL_HOLD_MS
  25000 (module-private in `server/routes.ts`), RENDERER_TTL_MS 40000,
  DEDUPE_WINDOW_MS 3000, MAX_TRACKED_THREADS 500, PROJECT_NAME_TTL_MS 300000
  (module-private in `server/context.ts`).
