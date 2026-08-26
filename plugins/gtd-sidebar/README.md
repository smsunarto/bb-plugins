<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# GTD Sidebar

**A thread list organized by who can act next.**

![bb 0.39+](https://img.shields.io/badge/bb-0.39%2B-88C0D0?style=flat-square)
![any platform](https://img.shields.io/badge/platform-any-3FA266?style=flat-square)
![experimental slot](https://img.shields.io/badge/uses-experimental%20SDK%20slot-F1B467?style=flat-square)

</div>

<div align="center">
<picture><img src="docs/media/hero.png" alt="The GTD Sidebar inbox beside its shelf model: Next Action, Waiting, Snoozed, and Settled" width="100%" /></picture>
</div>

GTD Sidebar replaces the scrolling thread list in bb's left sidebar with an inbox.

Active threads split into **Next Action** when the user can act and **Waiting** while
the agent works. Each section is oldest first. A thread that enters a section goes
to its bottom and holds that place until its next handoff.

While the sidebar stays mounted, this is exact entrance order. After an app reload,
bb does not provide historical section-entry times, so existing rows seed oldest
first from their last update time.

You clear the list with two email verbs: **snooze** a thread until a wake time, or
**settle** it when you are done. Both shelves collapse to one counted header.

## Install

**From the marketplace** — add this repository once, then install by name:

```sh
bb marketplace add git:github.com/smsunarto/bb-plugins
bb plugin install gtd-sidebar
```

bb resolves the newest `gtd-sidebar/vX.Y.Z` tag and builds the plugin from it against
your bb, so the bundle always matches the host it runs on. `bb plugin update
gtd-sidebar` follows the same release line. If another marketplace you have added
publishes a `gtd-sidebar`, spell it `gtd-sidebar@smsunarto`.

**From source** — clone the repo and install the plugin as a local path
source. This is also how you install a change that is not released yet:

```sh
git clone https://github.com/smsunarto/bb-plugins.git
cd bb-plugins
bun install
bun run --filter '@smsunarto/bb-plugin-gtd-sidebar' build
bb plugin install ./plugins/gtd-sidebar
```

The source path needs Bun and the `bb` CLI. It installs the plugin as a **local
path source**, so bb reads the files in place: edit, rebuild, reload, with no
reinstall.

## Requirements

- bb 0.39+
- Nothing else. No accounts, keys, or external services.

## Usage

Installing does not change your sidebar by itself. Open **Settings → Appearance →
Sidebar** and choose **GTD Sidebar (inbox)**.

<picture><img src="docs/media/enable.png" alt="bb's Appearance settings with GTD Sidebar (inbox) chosen for Sidebar" width="100%" /></picture>

bb's own list stays the default, and comes back the moment you switch away or
disable the plugin.

### Active and parked sections

- **Pinned** — the user's explicit priority, kept in its own shelf above active work.
- **Next Action** — the agent turn is done, an interaction needs input, or the thread is otherwise quiet. The oldest handoff is first.
- **Waiting** — foreground or background agent work is live. The oldest wait is first.
- **Snoozed** — hidden until the wake time you chose. A snoozed thread comes back early if it starts working or asks you something.
- **Settled** — work you are done with, collapsed to one line and shown for 24 hours. Settling also **archives the thread in bb**, so every other surface agrees, and new attention un-settles and unarchives it. After a day the row stops being drawn but stays archived.

An empty section disappears. A pending interaction stays in **Next Action** even if
background work is also live, because the user can act now.

### Cards

Two lines: the title in bold when unread and a status slot, then the project, the
branch, activity counts, PR number, and the agent (which you can turn off — see
[Configuration](#configuration)). The status slot shows what the
thread needs — failed, waiting on you, working, or finished while you were away —
and its age (`now`, `7m`, `3d`) when it needs nothing. Hovering swaps that slot for
the two park buttons.

The PR number uses the same colours bb uses elsewhere: muted grey for an open
PR, a paler grey for a **draft**, amber for a PR in the **merge queue**, purple
for merged, red for closed or failing. Badges come from one open REST list per
repository (not per-card GraphQL). A PR that has merged or closed drops off that
list, so the next tick looks it up by number (from the title or the last cache)
instead of treating the title as still open. Title text and the local cache are
the fallback when GitHub is rate-limited. Click a number to open the PR in bb's
in-app browser on that thread. Hold any modifier key (or click when the in-app
browser is unavailable) to open it in the system browser instead.

### A working thread can never be parked

Workflows, background agents, background commands, plan mode, and goals all count as
live work. Any of them blocks parking and wakes a parked thread, so running work is
never hidden.

### Snoozing

The hover button snoozes until **09:00 tomorrow**.

Once an hour the plugin asks GitHub about every snoozed thread that has a pull
request — one GraphQL query, not one call per PR. If comments, reviews, checks,
or deployments moved, it unsnoozes the thread and sends the agent a turn naming
what changed. The first observation is only a baseline, so a PR that already had
comments does not wake the moment you snooze it.

The watch uses the GitHub CLI (`gh auth login`) on the bb server. It skips the
hour when GitHub's GraphQL budget is too low and waits for GitHub's own reset
instead of retrying. Threads snoozed without a known PR are resolved a few at a
time so a cold shelf cannot burst the REST rate limit.

### Child threads

A flat list has nowhere to nest a child, so a child is hidden while its parent is on
screen. Two chips in the thread header carry the relation instead: on a parent, a
chip that opens its children and reads **Needs you** when one is blocked on you; on
a child, a chip that names the parent and opens it.

### The rest

- A project scope picker — the one control the plugin adds.
- Right-click for open in split, mark read/unread, pin, archive, delete.
- Drag a card to a split pane, or Cmd/Ctrl-click to open one.
- bb's search, its thread shortcuts, and modifier-click split-open all keep working.

## Configuration

One setting, in **Settings → Plugins → GTD Sidebar**:

- **Show the agent icon on each card** — on. Turn it off to drop the trailing agent
  glyph and give the branch that space back. Every card follows it together, so the
  meta line keeps a straight right edge either way.

The snooze presets assume a 09:00 morning, an 18:00 evening, and a week starting
Monday, in your local timezone. The settled shelf reaches back 24 hours. None of
these are settings.

## Troubleshooting

**My sidebar looks the same after installing.** Choose GTD Sidebar in Settings →
Appearance → Sidebar. Installing alone changes nothing.

**A thread I settled is not on the Settled shelf.** The shelf only reaches back 24
hours. Older work is still settled and still archived — look for it in bb's archived
view.

**A snoozed thread came back early.** That is the design: a snoozed thread wakes when
it starts working, asks you a question, or its GitHub pull request changed.

**Snoozed PRs never wake on GitHub activity.** The watch needs the GitHub CLI
logged in on the machine that runs bb (`gh auth status`). It also skips an hour
when GitHub reports too few GraphQL points remaining.

**Un-settling did not bring the thread back.** Archive and unarchive run on the
thread's host, which can be offline. When an unarchive fails, bb keeps the thread
archived and the thread leaves the sidebar until you unarchive it in bb yourself.

**Uninstalling left data behind.** The shelves live in the plugin's own database,
which bb removes with the plugin — but a copy of them is cached in the browser's
`localStorage` under `gtd-sidebar:v1:*` (thread ids, park timestamps, and provider ids,
names, and logo paths). bb's uninstall does not clear web storage. Clear site data if
that matters to you.

## Credits

Forked from bb's own example, and released as `t3sidebar` until 0.3.0. bb keys a
plugin by its id, so the renamed plugin installs as a separate one: install
`gtd-sidebar`, then uninstall `t3sidebar`. Shelves do not carry over — settled and
snoozed state lives in the old plugin's database and goes with it.

|          |                                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| Upstream | [`get-bb/bb` → `examples/plugins/t3sidebar`](https://github.com/get-bb/bb/tree/main/examples/plugins/t3sidebar) |
| Commit   | `f13c2d35f96540012b305f3b555839b30e1b6163` (2026-08-07)                                                         |

The provider brand marks are vendored SVG geometry from `get-bb/bb` and depict
third-party brands. A host-served logo always wins over them, rendered as a muted
silhouette rather than in brand color — by design.

## Develop from source

Install from source as shown under [Install](#install), then check a change
with:

```sh
bun run --filter '@smsunarto/bb-plugin-gtd-sidebar' typecheck
bun run --filter '@smsunarto/bb-plugin-gtd-sidebar' test
```

The test script needs Node 22.6+.
