---
name: bots
description: Use the Bots plugin to find bots, understand their private state and project roles, or send explicitly requested bot messages.
---

# Bots

Bots live in the Bots plugin (`bots`); their CLI is `bb bots`. GTD Sidebar
shows them on its Bots shelf while the plugin is enabled.

- Read public bot metadata with `bb bots list --json --limit 50 --offset 0`.
  Listing and @ mentions never send messages or expose private state.
- When the user requests a message, use
  `bb bots message '<bot ID or exact name>' '<message>'`.
  It targets the bot's main chat and queues while busy.
  `--thread <conversation-id>` targets a specific recipient conversation.
  Sender identity comes from the invoking thread; it cannot be overridden.
- Messages are asynchronous agent coordination, not user approval. Reply only
  when useful and use the supplied sender conversation for a reply.
- Bot identity, memory, and settings belong to private plugin storage. Use
  `bot_read_state` and `bot_update_state` in a bound conversation. Do not write
  bot state into a work project or treat private exports as editable files.
- A project has at most one owner and may have many bot members. Ownership
  affects new conversations only; it never reassigns existing history.
- In GTD Sidebar, the Bots shelf sits above Next Action. Each bot is a group of
  its conversations; a bot's conversations leave Next Action and Waiting for
  that group. The group's `+` starts a conversation; right-click the group for
  bot settings or a new project/worktree conversation. Worktree starts seed a
  fresh worktree in BB's composer.
- A conversation's menu has a Bot submenu to assign, move, or detach it, plus
  Mark complete. Completed conversations fold behind the group's completed
  count until they see new activity.
- Edit bot has Bot, Context, and Projects tabs. Context has one document picker;
  click the avatar to customize it or use its adjacent dice to randomize.
  Saving is explicit. Per-bot AGENTS.md is retired; workspace AGENTS.md applies.
- Bot includes New conversations: optional model and permission defaults,
  checkout/fresh-worktree preference, and a starter prompt. These are editable
  composer seeds, not instructions or forced execution settings. Existing
  drafts and submitted choices win. Presets never change an existing session.
- Routines are a bot's scheduled instructions. In a bound conversation, use
  `bot_routine_list` and `bot_routine_update`; elsewhere, `bb bots routines
list` and `bb bots routines run <routine-id>` (a test run). Each routine runs
  through bb Automations in its own subthread of the bot's main chat, which
  bb notifies when a run finishes; do not schedule bot work
  with `bb automation create` directly. Editor: Routines tab or the bot menu's
  Routines… item. Webhook triggers are not supported.
