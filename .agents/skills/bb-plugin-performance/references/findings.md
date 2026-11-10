# Performance findings and source map

These notes preserve the investigation continued from @thread:thr_xq5yh2zqbw on September 30, 2026. The source facts below were checked in the local `bb` and `bb-plugins` checkouts. Previous runtime counts come from that thread's report and were not measured again while creating this skill.

Paths beginning with `plugins/` or `packages/` belong to `bb-plugins`. The host source links assume `bb` is a sibling checkout. Recheck the installed builder and host before applying these facts to another version.

## Host compilation and plugin compilation differ

BB's [plugin app builder](../../../../../bb/packages/plugin-build/src/build-plugin-app.ts) bundles TSX with esbuild, automatic JSX, runtime shims, and a production environment definition. Its build path does not invoke React Compiler. The host's [Vite compiler integration](../../../../../bb/apps/app/vite-react-compiler.ts) uses `reactCompilerPreset()` through Babel.

Loading a plugin inside a compiled host does not compile that plugin's components. Compiler diagnostics from a standalone source probe also do not establish what the served plugin bundle contains.

The earlier investigation found that React Compiler skipped `ThreadDetailViewInternal`. Removing unsupported patterns and avoiding whole mutation objects in dependencies allowed it to compile. One demonstrated blocker was a `throw` inside `try`. Treat individual syntax examples as diagnostics for the installed compiler, not universal rules for every version.

The [compiler guard test](../../../../../bb/apps/app/src/views/thread-detail/ThreadDetailView.compiler.test.ts) collects `CompileError`, `PipelineError`, and `CompileSuccess` events. It requires success for `ThreadDetailViewInternal`. A generic successful build or a memo-cache marker elsewhere in the module would not prove that function compiled.

## Panel query updates had a broad subscription owner

Terminal sessions and storage files used to be observed by the thread page. Their responses re-rendered the page and rebuilt timeline and composer inputs. Those observers now belong to [ThreadDetailSecondaryContentBody](../../../../../bb/apps/app/src/views/thread-detail/ThreadDetailSecondaryContent.tsx), alongside terminal tab sync and storage tab pruning.

The panel body memoizes the timeline element using `footer` and `timeline`. Moving the queries alone would not isolate that sibling if the body recreated its inputs on every response.

The [secondary-content tests](../../../../../bb/apps/app/src/views/thread-detail/ThreadDetailSecondaryContent.test.tsx) resolve terminal or storage data and check that the unchanged timeline does not render again. The earlier investigation reported that removing the memo made both tests fail.

Observed renders per cold switch into a panel-open thread, as reported in the source build against the live server:

| Metric                           | Before    | After     |
| -------------------------------- | --------- | --------- |
| Thread page, three reported runs | 3 / 8 / 7 | 3 / 5 / 5 |
| Timeline pane                    | 6 to 8    | 3 to 4    |
| Prompt area                      | 10 to 11  | 4 to 5    |

These are historical diagnostic counts, not a benchmark or a latency guarantee. Load averages of 11 to 54 prevented a reliable elapsed-time claim. The report also noted that terminal fetching now starts after thread data loads, so terminal tabs can appear later.

## A mutation result is an unstable dependency

The installed TanStack Query `useMutation` returns a newly spread result object on each render. Its `mutate` callback uses the existing observer, and `mutateAsync` exposes the observer's bound method. Stability applies within that observer's lifetime, not across remounts.

Plugin RPC hooks are TanStack Query mutations. The host thread page now depends on the needed functions, including `sendMessageAsync`, instead of capturing whole mutation results.

Recheck `node_modules/@tanstack/react-query/src/useMutation.ts` and `node_modules/@tanstack/query-core/src/mutationObserver.ts` when the dependency changes. Do not stabilize an entire result object and accidentally hide status updates.

## Removing the panel key could corrupt another thread's layout

The desktop split path in [ThreadSecondaryPanel](../../../../../bb/apps/app/src/components/secondary-panel/ThreadSecondaryPanel.tsx) keys `SidebarSplitContainer` by `splitPanelStateId`. The panel's aside remains rendered while closed and becomes `inert` and `aria-hidden`. This says nothing about whether every plugin surface stays mounted in every panel mode.

[SidebarSplitContainer](../../../../../bb/apps/app/src/components/secondary-panel/SidebarSplitContainer.tsx) initializes state from the panel's storage key and persists layout in effects. Keeping an instance while changing its owner can expose thread A's state to thread B's write path. The investigation therefore kept the key.

The reusable lesson is to audit ownership before optimizing remounts. Mount-time work, retained hidden work, and thread-switch remounts are different costs. Check each surface's key and conditional rendering instead of assuming all plugin registrations have one lifetime.

## Request bursts were observed, but long polling was not established

The prior investigation observed thread-open requests for last-turn diffs, annotations, sessions, quota, and cloud state. Slow session and quota requests appeared in a stalled sample, but normal cold runs completed those methods in milliseconds. The evidence did not establish long polling or a connection-pool bottleneck as the root cause.

The host's [plugin SDK hooks](../../../../../bb/apps/app/src/lib/plugin-sdk-hooks.ts) send RPC calls through HTTP POST and deliver public `useRealtime` events through the shared WebSocket manager. Inspect request initiators, the browser's negotiated protocol, queueing, and server duration before proposing a transport change. Count the current enabled plugins' requests rather than treating the previous set as fixed.

For event-driven reads, [useLifecycleChannelList](../../../../plugins/gtd-sidebar/hooks/use-lifecycle-channel-list.ts) provides a local reference:

- A fixed 50 ms batch coalesces lifecycle signals without restarting its deadline
- Invalidation advances a revision before the delayed read starts
- Only responses from the current revision apply
- Mount and reconnect reads start immediately
- Failed reads retain visible data and follow the existing retry policy
- Cleanup prevents disposed work from applying

Its reads can overlap. Replacing that behavior with an unlimited single-flight wait could prevent recovery when a call never settles. Preserve the feature's failure behavior when changing request scheduling.

## Sidebar costs extend beyond React render counts

[ThreadCard](../../../../plugins/gtd-sidebar/components/inbox/thread-card.tsx) and [SlimRow](../../../../plugins/gtd-sidebar/components/inbox/slim-row.tsx) use memoized row boundaries. Stable row inputs matter because this plugin's bundle is not compiler-memoized.

[FadingText](../../../../plugins/gtd-sidebar/components/inbox/thread-details.tsx) uses one shared `ResizeObserver`. It reads overflow geometry for all delivered entries, then writes only changed flags. It re-observes when text changes because a longer title can overflow without changing the element's box.

[useInboxWindow](../../../../plugins/gtd-sidebar/hooks/use-inbox-window.ts) limits mounted rows using the existing virtualizer. It retains pinned rows, uses measured margins, and avoids a second scroll correction on top of browser scroll anchoring. Reuse those behaviors when evaluating large-list work.

The [Monokai template](../../../../plugins/monokai/scripts/bb-monokai.template.css) contains explicit state tags replacing broad relational selectors. [BB's utility scoper](../../../../../bb/packages/plugin-build/src/scope-plugin-utilities.ts) confines plugin styles with `:where()` selector roots. Measure style recalculation and layout during resize or streaming even when React render counts fall.

## Owned-root scoping narrows plugin CSS

October 2026 investigations (@thread:thr_se9qyngs5r, @thread:thr_4v44w32c6m) traced thread-switch style recalculation to the combined plugin stylesheets. Each plugin re-emits Tailwind utilities the host already supplies, and the builder's default scope prefix also matches anonymous roots: `[data-bb-plugin-root]` elements without a `data-bb-plugin` id. Every plugin's selectors therefore test against roots it does not own. Disabling one sheet at a time found no single culprit; deduplicating rules or dropping the anonymous-root branch in the browser roughly halved blocking time.

BB 0.49 ships the narrower variant without a plugin opt-in; it ignores the earlier `bbPluginBuild.experimental_cssScope` field and no longer emits `dist/app.owned-root.css`:

- **Gate:** the `narrowPluginCss` experiment makes the client request `app.css?css-scope=owned-root-v1`. Check it with `bb settings show --json`; it applies after a reload.
- **Eligibility:** the server derives the narrow sheet at load time by dropping the `[data-bb-plugin-root]:not([data-bb-plugin])` arm from the utilities layer. It does so only when the built `app.js` has no `data-bb-plugin-root` without a `data-bb-plugin` within 120 characters. Otherwise that plugin silently keeps the legacy sheet, and `bb plugin build` warns.
- **Roots:** give every mount and portal root the plugin's named `data-bb-plugin` identity. Plugins use a local `lib/portal-scope.ts` helper (`usePortalScopeProps`) for portaled overlays; refresh an old copy with `npx shadcn add @bb/portal-scope`. Audit body portals and shadow roots, since an unnamed root keeps the whole plugin on the legacy sheet.
- **Audit:** compare `cssUrl` from `GET /api/v1/plugins` fetched with and without `css-scope=owned-root-v1`; an eligible plugin's narrow sheet is about 30% smaller. On November 7, 2026, every enabled live plugin was eligible.
- **Lifetime:** the host attaches a plugin's sheet while one of its React slots, panel headers, portals, or content-script generations is active. Declarative entries such as an `experimental_threadAction` item do not attach it.
- **Volume:** use host components and utilities instead of re-emitting them, and keep generated, vendored, or copied output out of the plugin root, because the builder scans it for class candidates. Whiteboard's hand-written CSS (about 320 KB served) dominates once its tab or panel has mounted.
- Rank selector cost with a selector-stats trace. A CSSOM rewrite that won in the browser did not repeat once built and loaded normally, because the diagnostic rewrote rules the builder skipped.

## Universal-bucket selectors dominate the plugin share

A November 7, 2026 investigation (@thread:thr_pi9w9trdym) measured thread switches on a BB 0.49 test instance with the live plugin set, narrow CSS on, and the Monokai dark theme. On a fast desktop, style recalculation took about 22.5 ms per switch, against about 115 ms of script. Disabling every plugin sheet in the browser cut it to about 6 ms, so plugin CSS owned roughly 16 ms.

Selector stats (`disabled-by-default-blink.debug`, `SelectorStats` events keyed by `style_sheet_id`) ranked the plugin cost by rule shape rather than by sheet:

- **`space-*` and `divide-*`:** Tailwind compiles them to `… > :not(:last-child)`, which Blink tests against every element. Each distinct utility a bundle uses costs this, so a plugin saves only after every use in its bundle is gone, including components bundled from other plugins (gtd-sidebar bundles bots) and any other files under the plugin root.
- **Trailing `:is(…)` or `:not(…)`:** t3-composer's tray rules ended in `:is([data-…-footer], …)`. Listing each attribute let Blink bucket them and restyled about 280 fewer elements per switch.
- **Bucketed shapes:** rules ending in a class, tag, or attribute were cheap, including attribute-heavy composer rules and `[&>li+li]:border-t`.

Removing the `space-*` and `divide-*` utilities from the ten plugins whose sheets attach on a thread page, and rekeying t3-composer's tray rules, cut median style recalculation from 27.9 to 21.8 ms per switch (36 switches per side, alternating rebuilt bundles, host load about 8). The restyled element count fell from about 1,590 to 1,265. Host rules and builtin plugins' `space-*` utilities remain in the universal bucket.

Replacements that kept the captured surfaces pixel-identical. A flex column also drops margins `space-*` gave a control followed only by hidden siblings, such as inactive Radix tab panels or the native `<select>` Radix Select adds inside a form, and stretches inline-level children such as an `inline-flex` button unless it has `self-start`: `flex flex-col gap-*` for block stacks; spacing on the known label and hint for wrappers with arbitrary children, such as a host picker that a flex column would stretch; and `border-t first:border-t-0` or `[&>li+li]:border-t` for row dividers.

Splitting t3-composer's pill and icon-button `:is(…)` lists, and dropping a `> *` rule the pill rule already covered, cut that sheet's selector match attempts per switch from about 85,000 to 60,000. Computed styles stayed identical across hover, open, container-width, and coarse-pointer states, and the wall-clock change was below run-to-run noise. Two checks caught problems:

- **Specificity:** an `:is()` list takes its most specific argument's specificity, and each split selector keeps only its own. The split let a coarse-pointer `width: auto` rule that had always lost apply for the first time.
- **Descendant targets:** BB's `Square` icon draws a `path`, so `[&_rect]:stroke-0` missed it. Read the rendered markup before narrowing a `[&_*]` utility.

t3-composer's editor-content rules (`.ProseMirror … > *`, `::selection`) and `[data-promptbox-standard-actions] > *`, which also reaches host-provided children, remain universal.

## Pin bundle identity during comparisons

Concurrent rollouts changed several plugin bundles in the middle of these experiments. Hash the served JavaScript and CSS before and after each arm and discard arms whose hashes changed.

`bb plugin reload` rebuilds from the registered source when source files look newer than the built bundle. Copying theme or source files after `app.js` therefore triggers a rebuild from that source. Copy source assets first and built artifacts last, then verify hashes after reload.

Launch test servers from a process that outlives the agent's turn. Stopping a turn to deliver a message killed services started inside it.

## Instrumentation changed the observed workload

The earlier thread reported that a custom DevTools fiber hook increased measured long-task work by about three times in one comparison. CPU profiler startup also introduced noise. Neither observation is a universal overhead multiplier.

It also corrected an initial render-counting mistake: fibers visited during a commit include components that bailed out. Use validated render counters or trace evidence to identify actual component work. Do not equate fiber visits, React commits, function renders, DOM mutations, and paints.

Use a source frontend for attribution and an ordinary runtime for timing. Keep instrumentation consistent within each comparison, and explicitly remove it before claiming an improvement in the uninstrumented experience.
