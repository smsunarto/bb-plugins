# Whiteboard

> Draft (WP0). The plugin loads, but the engine, tools and panels are stubs
> until the later work packages land. WP9 writes the final text.

[dev.fast Whiteboard](https://github.com/devdotfast/whiteboard) running inside
bb. Agents author code walkthroughs, diagrams, sequence and call-stack views,
software maps and Diff lenses. Each session renders in the thread's side panel
next to the conversation, and the full catalog lives under Whiteboard in the
sidebar.

## How it fits into bb

- **Agent tools.** The upstream MCP catalog is registered as raw bb agent
  tools: `whiteboard_status` and `whiteboard_session_*` (for example
  `whiteboard_session_create`, `whiteboard_session_edit`). Descriptions and
  schemas come from upstream unchanged, apart from the tool-name rename.
- **Panels.** A thread panel shows one session. The sidebar entry shows Home
  with every session, and a full-page view of one session.
- **Auto-open.** When an agent opens a session, the server adds a durable tab
  to the thread and the client focuses it.
- **Git.** Git, `gh` and diffr run on the bb host that owns the repository,
  through the plugin's host entry.
- **Storage.** Sessions live in the plugin's bb database.
- **`/whiteboard`.** The composer command asks the agent to create a
  Whiteboard for the request and open it. It moved here from Kitchen Sink.

## Settings

| Setting      | Default | Effect                                                                                   |
| ------------ | ------- | ---------------------------------------------------------------------------------------- |
| Scratchpad   | off     | Shows the experimental scratchpad on Home. Changing it reloads the plugin's agent tools. |
| Software Map | off     | Shows the experimental Software Map view in sessions.                                    |

## Layout

Every upstream byte lives under a `vendor/` path segment and starts with a
`Vendored from dev.fast <path> @4ecc570 (MIT).` header. Lint and format skip
those paths. Authored code (facades, stubs, the bb bridge) lives outside them.

- `src/shared/contracts/`: frozen contracts between the server, host and app.
- `src/shared/vendor/`: browser-safe upstream model and protocol.
- `src/shared/node/vendor/`: upstream git and checkout helpers the host runs.
- `src/server/lib/vendor/`: the upstream engine (Hono API, store, tool catalog).
- `src/app/vendor/`: the upstream canvas, Home and Diff views, CSS scoped to
  `.review-canvas-root`.

The vendoring tool (`.scratch/whiteboard-port/vendor/vendor.ts`, untracked)
regenerates every vendored file from upstream and checks for drift. Imports are
redirected to authored modules instead of editing upstream files.

## Deviations from upstream

- **Tool names.** `session_*` tools are registered as `whiteboard_session_*`.
  The same rename applies to the upstream strings that name a tool in result,
  error and instruction text:
  - `review-api/http.ts`: `session_get(` in a result
  - `review-api/store.ts`: `session_get` in an error
  - `review-api/document-text.ts`: `session_lens_edit`
  - `review-api/instructions.ts`: three `session_get_instructions({topic:` references
  - the four instruction `.md` files
- **Settings pointers.** User-facing pointers to Desktop settings name the
  plugin settings in bb instead:
  - `review-api/http.ts`: "Turn it on in Review Desktop Settings." becomes
    "Turn it on in the Whiteboard plugin settings in bb."
  - `review-api/instructions.ts`: "the scratchpad can be turned on in
    Whiteboard Desktop Settings." becomes "… in the Whiteboard plugin settings
    in bb."
  - `review-api/instructions.ts`: "It can be turned on in Whiteboard Desktop
    Settings under Experimental Features." becomes "It can be turned on in the
    Whiteboard plugin settings in bb under Experimental Features." bb has no
    trace setting, so this pointer has no target yet.
- **`review_*` names stay.** A few upstream error strings still say
  `review_open`, `review_file` and similar. They are left byte-identical.
- **Not ported.** Sharing, telemetry, bug reports, the welcome and CLI install
  flow, trace storage, managed language workspaces and the Desktop window
  chrome. Their imports point at no-op stubs with the same exports.
- **Trace capture** is off (`traceEnabled` is a constant `false`).
  `trace_quote` blocks and uploaded traces still render.
- **Markdown** renders with the Docs TipTap configuration and bb's prose
  styles instead of upstream's mdast renderer.
- **Fixtures.** Upstream block and legacy-review fixtures sit at their
  upstream-relative path under `src/shared/vendor/review/src/fixtures/`,
  because the vendored specs read them by filesystem path.

## Known check warnings

`bun run check` exits 0 with these accepted warnings:

- **Rule 8, type-only edges.** Vendored app and shared files import engine
  types from `src/server/lib/vendor/` with `import type` (`Snapshot`,
  `ActivitySnapshot`, `LeaseScope`, `ReviewProgress`, `LocalReviewData`). No
  runtime code crosses.
- **Rule 8, host package root.** Vendored `structural-diff.ts` in
  `src/shared/node/vendor/` imports `src/host/lib/package-root.ts`, which finds
  diffr. Only the host runs that file.
- **Rule 8, fixtures.** `fixtures/blocks/fixtures.ts` imports `node:fs` for
  the specs. No app or server code imports it.
- **Rule 6.** `rpc/api.ts`, `rpc/info.ts` and `command/tool.ts` get their
  sibling tests with their owning work packages.

## License

MIT. The vendored dev.fast code is MIT under the dev.fast copyright. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for it and the bundled npm
assets.
