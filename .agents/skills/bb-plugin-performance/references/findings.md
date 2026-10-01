# Performance findings and source map

These notes preserve the investigation continued from @thread:thr_xq5yh2zqbw on September 30, 2026. The source facts below were checked in the local `bb` and `bb-plugins` checkouts. Previous runtime counts come from that thread's report and were not measured again while creating this skill.

Paths beginning with `plugins/` or `packages/bb-kit-core/` belong to `bb-plugins`. The host source links assume `bb` is a sibling checkout. Recheck the installed builder and host before applying these facts to another version.

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

bb-kit's [query accessors](../../../../packages/bb-kit-core/src/rpc/query/query.ts) delegate mutations to TanStack Query. The host thread page now depends on the needed functions, including `sendMessageAsync`, instead of capturing whole mutation results.

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

## Instrumentation changed the observed workload

The earlier thread reported that a custom DevTools fiber hook increased measured long-task work by about three times in one comparison. CPU profiler startup also introduced noise. Neither observation is a universal overhead multiplier.

It also corrected an initial render-counting mistake: fibers visited during a commit include components that bailed out. Use validated render counters or trace evidence to identify actual component work. Do not equate fiber visits, React commits, function renders, DOM mutations, and paints.

Use a source frontend for attribution and an ordinary runtime for timing. Keep instrumentation consistent within each comparison, and explicitly remove it before claiming an improvement in the uninstrumented experience.
