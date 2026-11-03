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

Kitchen Sink adds machine and checkout details, terminal access, and saved project scripts to BB's thread context card. Scripts can be added, edited, and run from the card. The card needs BB 0.48.1 or later with the `threadContextCard` experiment on; without it, these rows do not show.

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

## Clicky desktop companion

The optional [native macOS companion](companion/) answers voice questions through BB with a compact notch indicator, spoken replies, and optional click-through screen graphics. Settings are available from its menu-bar icon and open only when chosen. There is no chat window or conversation picker. Installing or reloading Kitchen Sink does not launch it.

Build with `companion/build-app.sh`. The app reuses saved BB connection preferences and the existing ElevenLabs key. Settings let you change the connection, execution machine, screen-context preference, voice, and key. Preferences are stored in `~/Library/Application Support/ClickyBB/interactions.json`; legacy `sessions.json` supplies settings on first migration. The key stays in macOS Keychain. Requires macOS 14 and Swift 6.2 or later; locally ad-hoc signed builds are not notarized. Remote BB connections use their authenticated local proxy URL, which may change after a host-daemon restart.

Hold **⌃⌥Space** to ask, then release to submit. **⌘⇧Space** stops the latest request and speech and clears graphics. The status at the notch is passive and passes clicks through. Holds automatically finalize at 30 seconds. Each question creates a fresh BB personal thread with current Accessibility context, a screenshot of the active window's entire display, and the previous five question/reply interactions requested within ten minutes. Older screenshots and graphics coordinates are not reused. The saved `includeInitialContext` preference can disable screen context. Missing desktop permissions are requested once after capturing the first voice question’s context, never at launch. BB retains the injected prompt and image; ElevenLabs receives microphone audio and spoken reply text.

Earlier running or unconfirmed requests never block a new question. Only the latest request may speak or show graphics; starting another recording silences earlier speech. Requests needing approval have individual menu entries that open BB’s own approval flow; the passive notch reports that attention is needed. Unknown writes are never retried: automatic recovery stops after two minutes, and long-running tracking stops after thirty minutes. Exact BB thread IDs remain available while records are retained. New local interaction history is timestamped; legacy settings are retained without importing undated conversations.

This is an independent HeyClicky-inspired implementation. Drawings appear only when helpful output includes them; transparent teaching marks pass clicks through, and the floating Clear button or ⌘⇧Space dismisses them. Interacting with a solid 3D part reveals detail, Play/Pause, Spread, and Reset controls. These small floating panels do not take keyboard focus. Animation starts with Play and respects Reduce Motion. Native capture is macOS-only; the BB server or execution machine may be remote. This app does not provide automatic desktop control; tasks use BB's tools and approval flow.

Run the companion's tests with `swift test --package-path companion`. Its native prompt is kept in `instructions/companion.md` and copied into the app bundle by the build script.
