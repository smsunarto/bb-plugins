---
name: bb-plugin-performance
description: Investigate and improve BB plugin UI performance, including slow thread switches, sidebar rendering, panel mounts, request bursts, and style or layout work. Use when measuring a regression or changing plugin rendering, subscriptions, or caching for speed.
---

# Measure and improve BB plugin performance

Find the work that delays the affected interaction, change its owner, and verify the same interaction again. Distinguish plugin work from BB host work and instrumented measurements from ordinary runtime behavior.

Read [the investigation findings](references/findings.md) when tracing thread switches, panel state, compiler behavior, or sidebar costs. They contain source pointers and the limits of the September 2026 measurements.

## Establish a comparable baseline

Use the repository's [verify-bb-plugins skill](../verify-bb-plugins/SKILL.md) to launch an isolated runtime and select the affected feature. Reuse its launch, doctor, browser, and cleanup procedures. Keep temporary probes and traces in that run's ignored evidence directory.

Record the conditions that can change the result:

- BB version, source revision, plugin source, build mode, browser, and viewport
- Enabled plugins, selected theme, thread IDs, timeline size, sidebar row count, and storage population
- Panel state before and after navigation, active panel tab, and split layout
- Query cache state, network cache state, instrumentation, and concurrent builds

Measure cold and warm destinations separately. Define what you cleared for a cold run. A browser reload does not necessarily clear query, browser, server, or plugin caches.

Compare closed-to-closed, closed-to-open, and open-to-open thread switches as separate cases. Keep the destination and starting state fixed within each comparison. Alternate baseline and changed runs when possible.

Use realistic list sizes and persisted state. Empty localStorage and a small sidebar can hide costs that scale with saved layouts or threads. Create large fixtures only inside the isolated runtime.

For a reported slowdown in the live app, first record its version, plugin configuration, and affected path. Confirm the isolated reproduction matches those conditions. A source frontend against the same server can help identify component names, but its development timings are a separate result. Account for server caches and avoid HMR reloads during measurement.

## Measure the interaction's completion

Define observable start and end conditions before collecting numbers. For a thread switch, start at the navigation action and end when the destination thread's expected control or content appears. Verify the destination ID as well as the URL so stale content cannot end the sample.

Collect the metrics that explain the delay:

- Time to the destination's usable content across repeated samples
- Long tasks and scripting, style, layout, and paint work in a browser trace
- Actual component renders, mounts, and commits
- DOM node counts, plugin request counts, and request queueing or response times

A DOM quiet window is supporting evidence. Animated content can prevent quiet, and an empty shell can appear quiet before data arrives. A `requestAnimationFrame` followed by a timer does not prove the destination painted.

Separate diagnostic runs from timing runs. A React DevTools hook, fiber traversal, console logging, or CPU profiler can add work. Time the ordinary path with those probes removed. Start recording before the navigation action.

If concurrent builds make timing unstable, report render, mount, node, or request counts and state that elapsed-time improvement remains unmeasured. Fewer renders alone do not prove a faster interaction.

## Attribute the repeated work

Trace the affected plugin's `app.tsx` registration through its component, hook, RPC, and server implementation. Use the trace to decide which layer owns the cost:

| Evidence                                                        | Inspect next                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| A panel response renders unrelated timeline or composer content | Subscription owner and prop identity                              |
| Every row renders for one thread update                         | Row inputs, shared context, and snapshot identity                 |
| Mount cost repeats on each thread switch                        | Host key, component initialization, and cache lifetime            |
| Scripting is small but style or layout dominates                | Theme selectors, DOM size, and layout reads                       |
| Requests start late or arrive in bursts                         | Initiators, query enablement, event invalidation, and server work |

A React commit can contain descendant work while a parent bails out. Visiting a fiber in a commit callback does not prove its component rendered. Validate any render-count probe with a known unchanged parent and changed child before using its counts. Temporary counters inside the affected component functions are another diagnostic option.

Compare changed inputs to find the trigger: props, subscribed context, query results, and state. Fiber hook positions are diagnostic clues, not stable public contracts. Remove temporary instrumentation after collecting evidence.

## Change the layer that owns the cost

Apply the finding that the evidence supports:

- **Subscriptions:** keep panel-only queries and derived state inside their consumer. Preserve query keys, enablement, error handling, and freshness behavior. Check whether moving a query delays its first request.
- **Prop identity:** BB's current plugin app builder uses esbuild without React Compiler. Preserve unchanged inputs and use targeted `memo`, `useMemo`, or `useCallback` where measured work warrants them. Do not add memoization across every component.
- **Mutation identity:** bb-kit's RPC hooks delegate to TanStack Query. Destructure the `mutate` or `mutateAsync` function you need instead of capturing the whole mutation result in callback dependencies. Preserve required status subscriptions.
- **Mounts:** keep initialization bounded and avoid repeated synchronous scans. Closing a retained panel does not stop its effects. Gate background work using the surface's actual visibility contract, when available.
- **State ownership:** preserve thread keys until every state value, ref, effect, subscription, and persisted write has a safe reset or lifetime. Test A-to-B navigation with different saved layouts before proposing key removal.
- **Requests:** reuse typed bb-kit RPC queries and supported SDK realtime hooks. Filter irrelevant signals and coalesce redundant reads only when freshness and failure recovery remain correct. A debounce must not postpone updates forever under a continuous stream.
- **Layout:** batch geometry reads before writes. Reuse the sidebar's shared overflow observer pattern instead of measuring each row while mounting it.
- **DOM size:** consider the sidebar's existing windowing pattern for measured list costs. Preserve keyboard navigation, active or focused rows, sticky headers, and scroll position.
- **CSS:** inspect style invalidation during thread updates and panel resize. Prefer explicit state attributes for measured broad relational selectors. Avoid indiscriminately deleting every `:has()` selector. Follow BB's prohibition on CSS `@scope`.

For host rendering, verify the loaded build's React Compiler output. A successful host build does not prove a particular component compiled. Use compiler logger events for the target function, following BB's existing compiler guard test. Do not treat this host check as a plugin compilation guarantee.

Use the public SDK's `useRealtime` and `useRealtimeConnectionState` hooks when realtime delivery fits the feature. `onPluginSignal` is a host implementation detail. Realtime notifications do not eliminate the reads needed to retrieve data.

## Verify behavior and performance together

Repeat the original comparison with the same content, cache conditions, panel states, theme, viewport, and instrumentation. Inspect the resulting UI. Match static checks to the changed plugin rather than rebuilding unrelated packages for a documentation-only change.

For lifecycle or subscription changes, exercise the relevant failure paths:

- A stale response arrives after navigation or a newer invalidation
- A read fails or stays pending while another update arrives
- The socket reconnects or the component unmounts with work pending
- A panel closes and reopens, or two threads have different saved state

When adding a regression test, call the consumer path and assert visible behavior or literal work counts. For render isolation, resolve the panel request and assert that unchanged timeline content did not render again. Confirm the test fails when that isolation is deliberately removed.

Report the consumer's changed behavior, the cause, the verified metrics, and any timing limitation. Separate direct source facts, previous observations, and hypotheses. Keep traces and probes in ignored evidence storage. Reload the live plugin only as required by the repository handoff rules, after isolated verification.
