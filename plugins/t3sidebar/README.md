# t3sidebar

An inbox-style replacement for bb's sidebar thread list, and the reference
example for `app.slots.experimental_threadList`.

Install it like any plugin in this repo:

```sh
bb plugin install ~/git/bb-plugins/plugins/t3sidebar
```

Turn it on in **Settings → Appearance → Sidebar**. bb's own list stays the
default, and comes back the moment you switch away or disable this plugin.

The plugin replaces the scrolling list only. bb's New-thread button, search
field, plugin nav rows, and footer stay exactly where they are — this list
filters by the host's search and adds just one control of its own, a project
scope picker.

## Fork provenance

Forked from bb's own example, which is MIT licensed (Copyright © 2026
Michael Yong):

| | |
|---|---|
| Upstream | [`get-bb/bb` → `examples/plugins/t3sidebar`](https://github.com/get-bb/bb/tree/main/examples/plugins/t3sidebar) |
| Commit | `f13c2d35f96540012b305f3b555839b30e1b6163` (2026-08-07) |
| License | MIT — see the upstream `LICENSE` |

Upstream is an in-repo example that builds inside bb's own workspace. The fork
carries three deliberate changes:

**1. Flattened `src/` to this repo's layout.** Filenames are kebab-case to
match the sibling plugins; exported symbol names are unchanged.

| Upstream | Here |
|---|---|
| `src/ThreadInbox.tsx`, `ThreadCard.tsx`, `SlimRow.tsx`, `StatusGlyph.tsx`, `StatusSlot.tsx`, `ProviderGlyph.tsx`, `ParentChip.tsx`, `SubagentsChip.tsx`, `RowContextMenu.tsx`, `Disc.tsx` | `components/inbox/<kebab>.tsx` |
| `src/components/Icon.tsx`, `Select.tsx` | `components/ui/icon.tsx`, `select.tsx` |
| `src/useLifecycle.ts` | `hooks/use-lifecycle.ts` |
| `src/inbox.ts`, `lifecycle.ts`, `relative-time.ts`, `lib/portal-scope.ts`, `lib/utils.ts` | `lib/*.ts` |
| `src/server.ts` | `server.ts` |
| `src/*.test.ts` | `test/*.test.ts` |

Cross-module imports use this repo's `@/*` tsconfig alias. Test imports stay
relative with explicit `.ts` extensions, because `node --test` resolves real
paths and not the alias.

**2. Dropped the two component tests.** `ParentChip.test.tsx` and
`ThreadInbox.test.tsx` import `@bb/plugin-sdk/testing/app`. That harness is not
obtainable outside bb's own workspace — it is unpublished on npm (the whole
`@bb` scope is empty), absent from GitHub Packages, not in the `bb-app` tarball,
never published by bb's release workflow, and not written by `bb plugin new`.
Upstream declares `"@bb/plugin-sdk": "workspace:*"`, which is why the tests run
there and cannot here.

The three pure-logic suites survive, converted from vitest to `node --test`
(43 cases). They cover the shelf rules including `canPark` — the invariant that
a working thread can never be parked. The React rendering and hook wiring are
**not** covered. Revisit if bb ever publishes the SDK.

**3. Fixed lint and dead code.** `useLifecycle` took a `threads` parameter it
never read, `ThreadInbox` bound a `useSidebarThreadActions()` result it never
used, and a `useMemo` listed a dependency its body did not reference. Four
`jsx-a11y` findings are suppressed inline with reasons: `role="img"` on inline
SVG, and `role="status"` on the empty-state messages, are both correct markup
that the rules mishandle, and the row anchors must stay anchors for bb's thread
shortcuts and modifier-click split-open to work.

## The idea

The list never re-orders itself. Threads sort by creation time, newest first,
and hold that place until you park them. Status lives inside each card instead
of in its position, so the sidebar only moves when you act — no row slides
away under your cursor because an agent finished something.

Three shelves:

- **Inbox** — three-line cards: project and one fixed-width status slot on the
  first line; title on the second; then branch (or the machine, when a thread
  has no worktree), activity counts, the pull-request number, and the agent
  glyph. Configured provider logos are used when available, with built-in
  Codex/Claude glyphs and a neutral dot as fallbacks. Pinned threads sit above.

  One slot, one marker, one width, so the whole column lines up. The slot
  shows the status glyph while a thread has something to say, and the age
  ("now", "7m") once it does not. The glyphs are bb's own: the red circle-x
  for a failure, the circle-question for a raised hand, the spinner for live
  work, and a blue notification dot for a thread that finished while you were
  not looking. Both lists sit in the same window, so they speak one language.

- **Snoozed** — hidden until a wake time you chose. A snoozed thread comes
  back early if it starts working or asks you something.
- **Settled** — work you are done with, collapsed to one line each.

## Child threads live in the header

A flat inbox has nowhere to nest a child thread, so the list hides a child
while its parent is on screen. Two chips in the thread header carry that
relation instead:

- On a parent: a chip with one coloured disc per child. It opens the list of
  children.
- On a child: a chip that names the parent and opens it. Without it the child
  is a dead end, because it is not in the list.

The parent chip sits on the left of the children chip, so the header reads up
then down. A child that has children of its own shows both. Each disc takes
its colour from the thread id, so the same thread keeps one colour in the list
and in both chips.

An orphan — a child whose parent is deleted — stays in the list, and its
header shows no parent chip.

## What it demonstrates

| Plugin API                                         | Used for                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `experimental_threadList`                          | the sidebar's scrolling list (bb keeps the New-thread button, search, nav rows, and footer) |
| `experimental_threadHeaderAction`                  | the two header chips: children on a parent, and the way back on a child                     |
| `experimental_useSidebarThreads`                   | live threads and projects, from the host's own cache                                        |
| `experimental_useSidebarThreadActions`             | open, open-in-split, new thread                                                             |
| `experimental_useSidebarThreadSplit`               | dragging a card out to a split pane                                                         |
| `experimental_useSidebarThreadPullRequest`         | the `#412` badge, coloured by bb's attention state                                          |
| `@radix-ui/react-context-menu` (shimmed)           | this plugin's own right-click menu, built on the action hook                                |
| `bb.storage.database()` + `bb.rpc` + `bb.realtime` | the settled/snoozed store                                                                   |

The plugin API ships **no components**. Status glyphs and the right-click menu
are both this plugin's own: `indicator` arrives as data, and every menu item is
one call on `experimental_useSidebarThreadActions`. Choosing them is the point
of a replaced sidebar. Deletion still routes through `requestDelete`, so BB
shows its confirmation dialog rather than a plugin deleting a subtree silently.
The small icon and select components also live here. This plugin does not
import BB's private shared UI package.

`@radix-ui/react-context-menu` and `@radix-ui/react-select` are devDependencies
because they are types-only here: bb runtime-shims the portaling radix families
into the host's own dismissable-layer and focus world.

## Where the lifecycle lives

Settled and snoozed state is in **this plugin's** SQLite database, never on
bb's thread. Putting it on the thread would mean a schema change, a wire
change, and a `HOST_DAEMON_PROTOCOL_VERSION` bump for a concept only this
sidebar understands. Uninstalling the plugin takes its state with it.

One rule matters more than the rest: **a thread that is working can never be
parked.** bb has more kinds of live work than a session status — workflows,
background agents, background commands, plan mode, goals — and every one of
them blocks parking and wakes a parked thread. Hiding running work is the one
failure this feature cannot afford. See `canPark` in `lib/lifecycle.ts`.
