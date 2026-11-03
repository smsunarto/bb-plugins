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

The optional [native macOS companion](companion/) gives BB a floating chat panel, a compact notch launcher, voice questions, screen attachments, spoken replies, contextual 2D/3D drawings, and agent jobs. It uses your installed BB CLI and its existing connection. Installing or reloading the Kitchen Sink plugin does not launch it.

Build with `companion/build-app.sh`, then open `companion/build/Clicky for BB.app`. Choose the machine that should run your agents in Settings. The companion discovers BB’s raw CLI and runs it through the packaged BB runtime, avoiding login-shell dependencies. Enter your authenticated local proxy URL for a remote BB connection. Its port changes when BB’s host daemon restarts; update the URL in Settings afterward. Current BB APIs do not expose automatic discovery of that port. Requires macOS 14 or later and Swift 6.2 or later to build. The app is locally ad-hoc signed, not notarized for distribution.

Press **⌘⇧Space** to show or hide the panel. Hold **⌃⌥Space** to ask a question without opening chat; releasing finishes the live transcript and sends it. Holds are limited to 30 seconds; reaching the limit leaves a draft for review. Starting another hold interrupts speech. If BB is still working, the new question stays in your draft. The microphone button in chat records a draft for review. Click **Capture screen** to preview an attachment. Microphone and screen recording access are requested only when you use those features. Add an ElevenLabs API key in Settings for realtime transcription and speech; the key is stored in macOS Keychain. You can choose an ElevenLabs voice ID there. BB retains sent messages and attachments; ElevenLabs receives microphone audio and the text spoken aloud. Voice questions get spoken replies; typed replies are silent unless enabled in Settings. Speech follows readable BB message lines, so BB's two-second event polling still bounds the response latency. Speech reads up to 1,500 characters per reply; the full text stays in chat. After restarting Clicky, an existing running turn stays silent. Locally re-signed builds may need Keychain authorization again through Check key in Settings.

Each conversation or job runs in a fresh BB personal workspace on the selected machine with user-reviewed escalation. **Open conversation in BB** handles permissions and richer tools or artifacts. **Stop agent** requests cancellation through BB. Cached transcripts stay visible offline; a failed send is marked unconfirmed and is never retried automatically. Refresh recovers an uncertain creation by its unique title when BB returns it in the personal thread list. If it cannot be recovered, inspect BB before starting another copy of the task.

This is an independent HeyClicky-inspired implementation. It supports one attached display per message and optional native diagrams, screen annotations, and interactive 3D scenes. Drawings appear only when an answer includes them; Clear hides the current drawing, and Show drawing reopens the latest saved result. Teaching marks pass mouse events through. The app starts at the notch after configuration. It does not provide dictation into other apps, a routines editor, a Chrome extension, video replay of drawings, or automatic desktop control. Tasks can use the tools available to their BB agent. Native UI and capture are macOS-only; a BB server or execution host can be remote.

Run the companion's tests with `swift test --package-path companion`. Its native prompt is kept in `instructions/companion.md` and copied into the app bundle by the build script.
