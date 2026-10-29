# bb-plugins

## Dev Commands

- Use `bb plugin dev ./plugins/<id>` for the plugin you are changing; reuse its watcher if one is running.
- Lint: `bunx oxlint --fix --format=agent`
- Formatting: `bunx oxfmt`.

## Dev Preferences

- Author plugins directly against `@get-bb/plugin-sdk`: `defineRpcContract` + `bb.rpc.register`, `cliCommand`/`defineCli` + `bb.cli.register`, `bb.agents.registerTool`, and `useRpc` with TanStack Query in the app. Read `plugins/html` for the reference layout. Workspace packages under `packages/` export source, never `dist/`.
- If something can be done through bb-plugin, do it through bb-plugin. If it's possible through bb-plugin, but it is hacky (no easy way to do it via the bb SDK, flag it to the user for approval first).
- If an implementation is ONLY possible through modification of bb's core app, flag to the user for approval first. DO NOT start work on bb core app without explicit approval.
- UI components: https://ui.shadcn.com
- Code diffs, syntax highlighting: https://diffs.com
- Prefer to use an existing color palette from `/plugins/monokai` theme. If a new color is needed, it should be added to the theme before being used. This is so that when we update the theme, the color change is applied to all plugins that use it.
- Always check whether the SDK provides an API that can be used to achieve the desired functionality before handrolling our own solution.
- Before adding or changing an agent tool, or reviewing its description, read and follow [tool-descriptions](.agents/skills/tool-descriptions/SKILL.md).
- Keep agent-facing text (thread instructions, prompts, tool descriptions) in `<plugin>/instructions/` and read it with `instructionFiles` from `@bb-plugins/instructions`. Tool descriptions go in `instructions/tools/<tool>.md`, with an optional `<tool>.instructions.md` thread snippet. Agent Instructions → Plugin prompts edits these files, so do not inline agent text in code.

## Local-first plugin design

Design plugins to remain useful across slow, intermittent, and independently failing connections.

- **Topology:** Identify the UI client, BB server, and checkout host separately. Account for a desktop with a local server, Personal Mac connected to a remote BB server with its checkout on either machine, and BB mobile connected to a remote server and a separate checkout host. A phone has no assumed checkout or CLI; a server connection does not establish checkout-host availability.
- **Platforms:** Support macOS and Ubuntu for server and host code, including mixed-OS connections. Detect the platform and required tools where each operation executes. Use portable runtime and path APIs; handle platform-specific CLI flags, tool locations, filesystem case sensitivity, and permissions explicitly. Keep macOS-only integrations optional with a usable Ubuntu path.
- **First render:** Show available local or cached data immediately, then refresh in the background. Label stale, offline, pending, and failed states accurately. Keep usable data visible through reconnects; a cache miss should load only the requested resource.
- **Scoped work:** Route reads and commands to the resource's owning host and checkout through the SDK. Resolve known identities directly. Keep fleet-wide discovery off the interaction's critical path and expose independent results as they arrive.
- **Failure isolation:** An unrelated slow repository, sleeping laptop, or disconnected host must not block available content or actions. Bound request deadlines, concurrency, and retries; coalesce shared reads, cancel obsolete work where supported, and reject late results for superseded selections.
- **Connection lifecycle:** Gate polling by surface visibility and connection state. Stop repeated discovery for missing resources, offer explicit retry, and reconcile after reconnect. Retry writes only when their semantics make repetition safe.
- **Consistency:** Share canonical, revision-aware data between cards, lists, and detail views. Preserve authoritative ownership of writes and show pending or failed outcomes; cached state alone must not imply a successful write or completed review.
- **Verification:** Verify relevant server and checkout-host behavior on both macOS and Ubuntu, including mixed-OS connections; report any untested platform. Exercise supported connection topologies with cold and warm caches, latency, disconnection, and reconnect. Assert that the selected resource becomes usable while an unrelated host stays pending, and that stale responses cannot replace newer data. Measure the complete user interaction and distinguish client-to-server latency from server-to-host work.

## Resizable thread side-panel tabs

- Every UI in a Thread side-panel tab (`thread-panel`) must adapt continuously to its container's available width and height as the user resizes it. Use container-aware layouts; browser viewport breakpoints alone do not describe the panel's size.
- Keep primary controls reachable at narrow widths. Wrap or stack controls, let flex/grid children shrink, and give overflowing content an appropriate scroll region. Reserve horizontal scrolling for inherently wide content such as diffs or tables; keep panel controls within the available width. Preserve UI state and keyboard focus during resize.
- Verify the actual registered tab at narrow, intermediate, and wide widths and short and tall heights. Drag the divider in both directions and reopen a tab at its saved size. Check for clipped content, overlapping controls, unwanted outer scrolling, and resize-triggered state resets or remounts.

## Agent orchestration

- Prefer BB primitives, such as CLI-managed subthreads, messaging, waiting, and lifecycle cleanup, for agent orchestration. Describe workflows, prompts, and decision points in agent instructions or skills so the agent can compose and adapt the steps to the task.
- Use small scripts or CLI commands to package repetitive setup, argument construction, or result formatting when they reduce boilerplate and token usage. Keep these helpers composable and inspectable, with explicit inputs, results, and thread identities.
- Keep planning, branching, and recovery decisions in the agent-guided workflow. Add a custom orchestration tool only for a concrete capability the existing primitives cannot provide reliably; keep its responsibility narrow.

## Work -> Plugins Routing

- Prefer to group work into an existing relevant plugins. Obtain explicit approval before creating a new plugin.
- Styling, themes, bb UI: `/plugins/monokai`
- Left sidebar: `/plugins/gtd-sidebar`
- Misc. Catch-all: `/plugins/kitchen-sink`

## Catalogs

`marketplace.json` (repo root) is the public catalog `bb marketplace add` reads. `.bb/plugins.json` is the collection index `bb plugin install --plugin` reads. They are not interchangeable, and bb will not look for `marketplace.json` under `.bb/`.

When you add, rename, or remove a catalog plugin, update both files in the same change: every `marketplace.json` `id` needs a matching `.bb/plugins.json{ "name", "source": "./plugins/<id>" }`. Leave unpublished personal plugins out of `marketplace.json`. `.bb/plugins.json` may list those extras.

## Environment

- By default, running `bb` commands points to the user's live bb instance. Run `bb --version` to see what bb version the user have installed.
- For plugin development, use BB's own `plugin build`, `plugin install`, and `plugin dev` commands.
- If verification needs another BB build, follow that BB checkout's `docs/debugging-and-qa.md` and `scripts/bb-dev-app` launcher. This repository does not manage BB instances.

### Verification

Use BB's bundled `bb-plugin-authoring` skill and its `references/testing.md` for SDK tests and the live plugin loop.

- Review UI and capture visual evidence using bb in a web browser, not the desktop app. Enable the Monokai plugin, select the **bb Monokai** theme, and set appearance to **Dark**. Confirm the rendered UI uses both before evaluating it.
- Run focused tests with `@get-bb/plugin-sdk/testing`, `/testing/app`, or `/testing/host` for the affected contracts.
- Use `bb plugin dev` when the affected plugin is not already watched. Inspect its source, status, logs, or RPC with BB's plugin commands.
- When using another BB build, read its URLs and routing from BB's launcher. Use that checkout's `pnpm bb:dev` CLI against it.
- Verify the changed user flow in a browser when rendering or host integration matters. Capture and inspect evidence, remove this run's test records, and close only its browser session.
- When a check needs separate state, use BB's own QA tooling. Stop only test resources that this task created.

For plugin UI performance investigations, read `.agents/skills/bb-plugin-performance/SKILL.md`.

### Handoff

If modifying an existing plugin (after focused checks and the affected live user flow pass):

- Run `bb plugin source <id>` and make sure bb is loading the plugin from the correct local path instead of NPM installation, etc. If it's not, reinstall the plugin using local path source.
- Always use `bb plugin reload <id>` against the live bb and confirm it is running before handoff.
- If the plugin cannot be reloaded, explicitly state that it was not reloaded and explain the blocking reason to the user. Never silently skip the reload.

If creating a new plugin:

- Run `bb plugin install [options] <source>` pointing at the user's live bb instance.

When communicating the handoff:

- Explicitly state whether your work has been committed or remains uncommitted.
- If a plugin was installed or reloaded: insert a heading `Plugin Reloaded` with a bullet list of target plugins.

## Traps

- When you capture plugin screenshots, follow the `bb-plugin-screenshots` skill.
- Do not point `BB_SERVER_URL` at the dev App port, point it the Server port.
