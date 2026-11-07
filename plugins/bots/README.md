# Bots

Named specialists with private instructions and memory, each with its own
conversations. [GTD Sidebar](../gtd-sidebar) shows them on its **Bots** shelf
while this plugin is enabled; disable Bots and the shelf disappears.

A bot keeps its identity, instructions, and up to 3,000 characters of memory in
this plugin's private storage. On GTD Sidebar's Bots shelf, hover the shelf
header for **+** to create one. On a bot's header, **+** starts a conversation in
the project it owns, or a projectless one; right-click it to start one in a
project or a fresh worktree, edit the bot, manage its projects, hide it until its
next activity, or move it up and down.

Any thread's menu has **Bot** to assign it, move it with its children, or detach
it, plus **Mark complete** on a bot's conversation. The thread Info tab shows the
thread's bot and what it adds to the agent's prompt. Completed conversations fold
behind the header's **Show N completed** until new activity reopens them; idle
ones complete on their own after the hours set in this plugin's settings. Live
workflow runs show as rows under the conversation that started them.

Agents in a bot's conversations read and update its state with `bot_read_state`
and `bot_update_state`. `bb bots list` and `bb bots message <bot> "<message>"`
let agents find and message bots; `@` completes bot names in the composer
without sending anything.

## Moving from GTD Sidebar

GTD Sidebar stored bots in its own database before this plugin existed. On its
first start, Bots copies those rows (bots, bindings, state, completions) from GTD
Sidebar through GTD's `retired_bots_export` RPC, which only this plugin may
call. The import runs once; GTD Sidebar keeps its copy untouched. The CLI moved
from `bb gtd-sidebar bots` to `bb bots`.

## Lineage

Forked from Tobi Lütke's
[`tobi/bb-bots-sidebar`](https://github.com/tobi/bb-bots-sidebar) at `v1.1.0`
(`ff5853061ea1cffda1992b85dd4dc6631a1f085a`). That repository publishes no
license, so this fork is for personal use until it has one. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
