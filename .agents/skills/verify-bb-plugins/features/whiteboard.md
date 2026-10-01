# Whiteboard

Entry: the Whiteboard sidebar item, or a session tab opened by an agent.

Use a temporary repository with base/head commits and a dirty worktree file.
Register it through `whiteboard_session_register_repository`. Run the tools
through this verification runtime's routed `BB_CLI`.

## User path

1. Open Whiteboard Home before creating a session. Confirm both starter prompts.
2. Create a session from a fresh agent thread. Confirm its durable tab appears
   and focuses without a click.
3. Author the upstream block fixtures and two file lenses. Confirm Markdown,
   diagrams, images, uploaded traces and Software Maps render.
4. Follow a `review-source:` link. Confirm a read-only peek uses bb's code or
   diff component. Open a live source file in bb's File Editor.
5. Open Diffs. Switch lenses and toggle Viewed. Confirm file counts and selected
   diffs change. Expand context with bb's native diff control.
6. Rename the session and confirm the tab title changes. Reload the page and
   confirm the same tab and document remain.
7. Toggle Scratchpad in plugin settings. Confirm it appears on Home and a fresh
   agent receives scratchpad guidance.
8. Check dark and light appearance and a compact viewport. Confirm canvas
   styles stay inside the Whiteboard surface.

## Stable contracts

- `[data-wb-panel="nav"]` and `[data-wb-panel="thread"]`: plugin surfaces.
- `.review-canvas-root`: canvas scope.
- `.bb-markdown-prose`: Docs Markdown styling.
- `.review-changed-files`: changed files and Viewed controls.

## Evidence

Record tool names, block kinds, literal expected results and observed results.
Capture Home, the populated document, Diffs and the File Editor result. Record
the interactive path and inspect the saved recording before delivery.

Trace capture/storage, Desktop sharing and managed language environments are
outside this plugin. Uploaded trace quotes remain supported. Do not treat tool
registration or successful builds as proof that the user path works.
