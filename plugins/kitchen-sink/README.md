<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# Kitchen Sink

**Personal BB thread tools: project scripts, task lists, navigation, and completion feedback.**

![bb 0.47+](https://img.shields.io/badge/bb-0.47%2B-88C0D0?style=flat-square)

</div>

## What it does

Kitchen Sink adds machine and checkout details, terminal access, and saved project scripts to a floating thread details card. Scripts can be added, edited, and run from the card.

Its composer skills are `/project-scripts`, `/subthread`, and `/test-remotely`.

## Thread motion

Kitchen Sink fades thread switches and smooths automatic timeline scrolling. A
"Jump to latest event" palette command (Mod+Shift+J) scrolls the current thread
to its live tail. See
[thread switching and scrolling](src/app/timeline-motion/README.md) for behavior and limitations.

## RPIV task list

Kitchen Sink includes the [RPIV Todo renderer](https://github.com/ZhenHuangLab/bb-rpiv-todo-renderer)
by ZhenHuangLab, adapted under its [MIT license](src/app/rpiv-todo/LICENSE).
It shows a collapsible task list above thread, queued-message, and side-chat
composers, with completion counts and the current task first. The agent needs
`@juicesharp/rpiv-todo` installed in Pi; Kitchen Sink only renders its `todo` calls.

The list replays successful, completed tool calls from server-stored events. It
refreshes while running and on reconnect, keeps saved tasks visible when offline,
and reads long histories in bounded batches. It never contacts the checkout host.
Turn off **Expand RPIV task list when opening a thread** in Kitchen Sink settings
to start collapsed. Transcript tool cards retain BB's standard rendering.

## Turn completion sound

Kitchen Sink plays a sound in your browser when a top-level thread becomes idle, so you
hear it on the machine you are using, wherever the BB server runs. It also plays
while the thread is focused or the tab is in the background. Subthread completion
stays silent.

- **Sound:** Cursor's completion sound, the asset the retired Notify plugin used.
  The server reads it from any connected machine with Cursor at
  `/Applications/Cursor.app`, keeps it in memory, and serves it at
  `/api/v1/plugins/kitchen-sink/http/completion-sound`. Kitchen Sink does not
  ship the file. When no machine has Cursor, the browser synthesizes a short
  chime instead.
- **One tab plays:** with several BB tabs open, one tab per browser plays. A tab
  takes part only after you have clicked or typed in it, because browsers block
  sound in a tab you never touched.
- **Blocked audio stays silent:** if the browser refuses playback, nothing is
  shown and the agent is not interrupted. Safari allows sound only from audio
  that a click or key press started, so the tab unlocks its audio on your first
  click or key press, and again after any refusal.
