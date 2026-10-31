# bb-plugins

## Dev Commands

- Run `bb plugin dev <test-plugin-path>` against the separate test instance described under Environment; reuse a watcher only when its instance and source path match this task.
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

## Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

Plugin server entries bind Effect to the Plugin SDK only through `makePluginRuntime` from `@bb-plugins/effect-bridge`; read `packages/effect-bridge/src/effect-bridge.ts` before wiring a runtime. Host entries and modules the app bundle imports stay Effect-free.

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

## Performance and resource use

Every enabled plugin shares BB's page, server, and host daemon, so plugin costs add up. Choose the implementation that keeps BB responsive and its CPU, memory, network, and disk use low while staying reliable. When the cheaper design would weaken correctness or failure recovery, keep reliability and state the tradeoff. To measure or attribute a slowdown, read [bb-plugin-performance](.agents/skills/bb-plugin-performance/SKILL.md).

These patterns slowed BB or were implicated in this repository's performance investigations. Check new and changed code for them:

- **Stylesheet weight:** BB matches every loaded plugin stylesheet against the whole document on each thread switch and panel toggle, so the cost is aggregate and no single sheet looks guilty. Use host UI components and utilities instead of re-emitting them, and keep generated, vendored, or copied files out of the plugin root, which the builder scans for Tailwind classes. Give every mount and portal root the plugin's named `data-bb-plugin` identity and opt into `bbPluginBuild.experimental_cssScope: "owned-root-v1"`; audit body portals and shadow roots first.
- **Invisible surfaces:** A registered slot that renders `null` still mounts on every instance and keeps the plugin's stylesheet attached. Register visual slots for visible UI only.
- **Forced layout on mount:** Synchronous geometry reads such as `getBoundingClientRect` or `offsetHeight` during mount or navigation force pending style and layout. Take sizes from `ResizeObserver` entries, check cheap state before measuring, and batch reads before writes. Scope pointer and keyboard listeners to the component rather than the document.
- **Unstable identities:** Plugin bundles get no React Compiler. Rebuilding derived arrays, item objects, or handlers on each render re-renders every memoized child, as on a canvas re-rendering all cards per keystroke. Reuse unchanged item objects and pass stable callbacks across list and canvas item boundaries.
- **Remount churn:** Hidden UI torn down and recreated on each navigation repeats its mount cost. Mount on first activation and keep the instance, preserving shortcuts and focus return.
- **Fleet fan-out on a default path:** A tool or RPC that queries every host and waits for all of them runs at the slowest host's speed. Default to the calling thread's environment and host, matching canonical paths; make wider discovery an explicit argument. When fixing one caller, audit the other callers of the shared discovery helper.
- **Heavy payloads:** Inline media or large blobs in thread events, startup context, or turn input bloat BB's database and every reader that parses them. Pass files or attachment references, and parse large JSON once rather than on every poll.

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

- Bare `bb` commands normally target the user's live instance. Use a separate BB instance for plugin development and integration testing, with its own data directory, server/host-daemon ports, and browser session. Reserve live plugin mutations for the final Handoff below.
- Prefer the same BB version as live. Use BB's supported launcher and configuration interfaces; read the installed help and the matching BB checkout's `docs/configuration.md` and `docs/debugging-and-qa.md` before setup. For packaged BB, the documented isolation controls are `bb-app --data-dir <test-data-dir> --server-port <port> --host-daemon-port <port>`; source builds use that checkout's current launcher. Do not assume a `scripts/bb-dev-app` helper exists.
- Record the live and test server URLs, data directories, versions, and checkout paths separately. Verify that the server URLs, data directories, and writable plugin source/build paths differ before any test install, reload, or mutation. Route every test CLI/RPC call and watcher explicitly to the test server; `BB_SERVER_URL` must be its server API URL. For a source build, use its `pnpm bb:dev` CLI.

#### Seed the test instance from live

- At initial setup, read the live plugin inventory, resolved sources/versions, enabled states, BB settings, and plugin settings. Recreate that configuration in the test instance using the supported CLI/SDK interfaces (`bb plugin list`, `bb plugin source`, `bb plugin config`, `bb settings`, `bb theme`, and UI-preference APIs). Include custom theme assets and reproduce browser-local appearance settings in the test browser. Read current help/contracts rather than assuming these commands export or import a complete configuration.
- Install independent copies of the live plugins at their resolved versions, preserving enabled/disabled states and settings. Local-path plugins must use test-owned source and build-output copies, including any shared workspace dependencies; live and test must not serve bundles from a directory that test builds overwrite. Apply the task's current changes to those test sources before building or watching them.
- Copy configuration only, not the live database or whole data directory. Keep test projects, threads, plugin runtime databases, schedules, host identities, enrollment, and Connect registration independent. Rebind host/project/path-specific settings to disposable test resources; isolate any copied configuration that would otherwise act on live resources or external services before activating its plugin.
- Transfer required secret settings privately through supported secure inputs, without printing values or copying live HTTP tokens or machine/account session identities. Use test credentials where available. Report settings that cannot be reproduced and any deliberate test overrides; do not claim exact parity when configuration differs.
- Compare the resulting plugin inventory, versions, enabled states, and settings with the live baseline before testing. Reuse a matching test instance without overwriting another task's work; refresh its baseline only when it is idle and owned by this task. Record test source-path substitutions and other intentional differences.

### Verification

Use BB's bundled `bb-plugin-authoring` skill and its `references/testing.md` for SDK tests and the live plugin loop.

- Review UI and capture visual evidence in the test instance's web browser, not the desktop app. Enable the Monokai plugin, select the **bb Monokai** theme, and set appearance to **Dark** there. Confirm the rendered UI uses both before evaluating it.
- Run focused tests with `@get-bb/plugin-sdk/testing`, `/testing/app`, or `/testing/host` for the affected contracts.
- Use `bb plugin dev` on the test-owned source when the affected plugin is not already watched on that test instance. Inspect its source, status, logs, or RPC with commands routed to the same test server.
- Confirm the test instance runs the intended plugin source and current task changes before exercising the flow; a successful check against the live plugin is not verification of the test build.
- Verify the changed user flow in a browser when rendering or host integration matters. Capture and inspect evidence, remove this run's test records, and close only its browser session.
- Use disposable test state and BB's own QA tooling. Stop only test resources that this task created.

For plugin UI performance investigations, read `.agents/skills/bb-plugin-performance/SKILL.md`.

### Handoff

After focused checks and the affected user flow pass on the separate test instance, promote only the validated task changes to live. Explicitly switch CLI routing back to the recorded live server and confirm its identity first.

If modifying an existing plugin:

- Run `bb plugin source <id>` and make sure bb is loading the plugin from the correct local path instead of NPM installation, etc. If it's not, reinstall the plugin using local path source.
- Always use `bb plugin reload <id>` against the live bb and confirm it is running before handoff.
- If the plugin cannot be reloaded, explicitly state that it was not reloaded and explain the blocking reason to the user. Never silently skip the reload.
- Do not leave a development watcher targeting live; future edits belong in the test-instance loop.

If creating a new plugin:

- Run `bb plugin install [options] <source>` pointing at the user's live bb instance.

When communicating the handoff:

- Explicitly state whether your work has been committed or remains uncommitted.
- Report the test-instance identity, configuration differences, and verification separately from the final live install/reload.
- If a plugin was installed or reloaded: insert a heading `Plugin Reloaded` with a bullet list of target plugins.

## Traps

- When you capture plugin screenshots, follow the `bb-plugin-screenshots` skill.
- Do not point `BB_SERVER_URL` at the dev App port, point it the Server port.
