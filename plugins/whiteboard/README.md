# Whiteboard

[dev.fast Whiteboard](https://github.com/devdotfast/whiteboard) running inside
bb. Agents author code walkthroughs, diagrams, sequence and call-stack views,
software maps and Diff lenses. Each session renders in the thread's side panel
next to the conversation, and the full catalog lives under Whiteboard in the
sidebar.

## How it fits into bb

- **Agent tools.** The upstream MCP catalog is registered as raw bb agent
  tools: `whiteboard_status` and `whiteboard_session_*` (for example
  `whiteboard_session_create`, `whiteboard_session_edit`). Descriptions and
  schemas come from upstream. Tool names, wording and settings pointers adapt
  to bb, and schema references expand for bb tool registration.
- **Panels.** A thread panel shows one session. The sidebar entry shows Home
  with every session, and a full-page view of one session. In a full-page
  session, All Whiteboards at the right of bb's title bar returns to Home.
- **Auto-open.** When an agent opens a session, the server adds a durable tab
  to the thread. Clients showing the thread focus it at once. A client that
  shows the thread within the next 5 minutes, or reconnects in that time,
  focuses it on arrival, with its current title. It does not focus a tab closed in the meantime. Phone-width
  viewports never focus it. Tabs opened from Home or a link are tracked too.
  They follow renames and close when the session is dismissed or deleted.
- **Git.** Git, `gh` and diffr run on the bb host that owns the repository,
  through the plugin's host entry. That host can be another machine than the
  bb server or the browser.
- **One host per path.** Registering a repository binds its path to the
  calling thread's host, and the path is read only there. Whiteboard keys
  checkouts by path, so a path registered from one machine is refused (409,
  naming both machines) from another machine that has a checkout at the same
  path. Use a thread on the first machine, or a checkout at another path.
  A session on that repository reads the first machine's checkout, whichever
  thread creates or reads it. Routing matches registered path prefixes, so a
  checkout from a second machine that lands under the first machine's
  registered path (for example inside its shared Git directory) is read on
  the first machine.
- **Offline hosts.** When a repository's host is not connected or stops
  answering, reads fail with 503 and name that machine. A cheap check (tool
  probe, checkout exists, watch liveness) on a host that stopped answering
  fails after about 11 seconds: bb adds 6 seconds of grace to its 5-second
  budget. Creating a Whiteboard from a pull request URL skips checkouts on
  hosts that cannot be reached. Home's structural diff mode follows the first
  host that has diffr. While a live-worktree watch is armed, its host is
  asked every 10 seconds whether it still holds it, and a watch lost to a
  daemon restart is armed again.
- **Storage.** Sessions, retained resources and history live in the plugin's bb database.
  Worktree source is retained in namespaced Git refs on its host. Each generation
  keeps raw source bytes and a Git-normalized comparison tree. Older review versions
  keep their source, and stale live generations are pruned.
- **Code views.** Read-only peeks and diffs use bb's own source and diff viewers.
  A peek on an unchanged file, or outside every changed hunk, renders as a
  context-only bb diff. Each authored range shows with three lines of context.
  bb's expanders hold the rest of the file. This refines design §0.1, which used
  SourceCode with highlighted lines, because bb's plugin SourceCode does not
  scroll to them. It still uses bb's own viewers and no Monaco. Peek headers
  name the range (`path:from-to`) and show the peek's remaining counts, or
  "Unchanged" for referenced context. Sources that match the live file open in
  bb's File Editor, at the peek's range or a diff's first changed line. Other
  sources stay read-only. Once the source loads, the path tooltip says why.
  Raw source peeks retain the live file's bytes. A peek that is loading or
  cannot resolve shows one muted row with its file and range
  ("Loading path:from-to…" or "Can't show path:from-to").
- **Diffs view.** Marking a file viewed folds it to its header. Unmarking it
  reopens it, as on GitHub. Viewed and folded files start folded. Split diffs
  render inline below 900px, as Monaco does. Each diff loads when it comes
  within 600px of view. A file shows Open file once its diff loads. A file that
  starts folded shows Open file after you expand it.
- **Starter prompts.** An empty Home offers upstream's change and architecture
  prompts. Start in a new thread opens bb's composer with the prompt, and Copy
  prompt copies it. The empty state also points to `/whiteboard`.
- **Add to chat.** Selecting text in a Whiteboard document shows
  "Add to chat ⇧⌘C". It quotes the selection into the composer and adds a pill
  with the Whiteboard's title. The pill gives the agent the session ID and
  displayed version, with the `whiteboard_session_get` call that reads it.
  You do not see that context in the draft. In a thread panel, the quote and
  pill go to that thread's composer. On the full page, they go to the
  new-thread draft and bb opens compose. The quote goes to the pane the text
  was selected in, even if focus moves before it lands. If it cannot reach a
  composer, the popover says it could not add the selection. ⇧⌘C is also bb's Focus
  composer shortcut. Whiteboard takes the key only while text is selected in
  a Whiteboard. Without a selection, bb's shortcut works unchanged.
- **`/whiteboard`.** The composer command asks the agent to create a
  Whiteboard for the request and open it. It moved here from Kitchen Sink.

## Settings

| Setting      | Default | Effect                                                                                 |
| ------------ | ------- | -------------------------------------------------------------------------------------- |
| Scratchpad   | off     | Gives each BB thread its own scratchpad. Changing it reloads the plugin's agent tools. |
| Software Map | off     | Shows the experimental Software Map view in Whiteboards.                               |

The `scratchpad` alias resolves within the calling BB thread. Older shared
content stays in a read-only archive on Whiteboard Home and is not copied
into a thread's pad.

## Layout

Whiteboard began as a port of dev.fast Whiteboard at `4ecc570` (MIT, see
THIRD_PARTY_NOTICES.md). The code is maintained here; nothing syncs from upstream.

- `src/shared/contracts/`: contracts between the server, host and app.
- `src/shared/review/`, `src/shared/review-protocol/`, `src/shared/json/`:
  browser-safe document model, blocks and canvas protocol.
- `src/shared/node/`: git, worktree and checkout helpers the host runs
  (`review/`, `local-vcs/`, `fs/`).
- `src/server/lib/review/`: the engine (store, local data, progress, lenses).
- `src/server/lib/host-io/`: server facades that run git and file reads on the
  checkout's host.
- `src/app/review/`: the canvas, Home and Diff views. Their CSS uses a
  zero-specificity `:where(.review-canvas-root)` prefix, because bb forbids
  `@scope`; `src/app/styles/` holds the bb overrides and tokens.

Backports from upstream after the port: [#634](https://github.com/devdotfast/whiteboard/pull/634)
resets a block's render error after an edit, [#637](https://github.com/devdotfast/whiteboard/pull/637)
keeps flow layouts matched to their block and direction, and the source-resolution
part of [#1232](https://github.com/devdotfast/whiteboard/pull/1232) resolves code
references when a file exists on only one side. The host preserves read failures
and per-item size-limit failures as errors across Git and jj, so only absent files
can resolve as one-sided context. Flow updates keep the last consistent drawing
mounted while the new layout loads, preserving the reader's viewport and inline height.

The authoring, file-lens and scratchpad prompts live under `instructions/`, with
the component reference and tool descriptions, and are read through
`instructionFiles`. Prompts pick up edits on the next call; tool descriptions
apply after a plugin reload. The `/whiteboard` skill loads the authoring prompt.

## Deviations from upstream

- **Tool names.** `session_*` tools are registered as `whiteboard_session_*`.
  The same rename applies to the upstream strings that name a tool in result,
  error and instruction text:
  - `review-api/http.ts`: `session_get(` in a result
  - `review-api/store.ts`: `session_get` in an error
  - `review-api/document-text.ts`: `session_lens_edit`
  - `review-api/instructions.ts`: one `session_get_instructions({topic:` reference
  - Embedded scratchpad text adapts tool names at the bb boundary.
    The vendored instruction files retain the baseline for comparison;
    authoring and file-lens guidance comes from `instructions/` instead.
- **Settings pointers.** User-facing pointers to Desktop settings name the
  plugin settings in bb instead:
  - `review-api/http.ts`: "Turn it on in Review Desktop Settings." becomes
    "Turn it on in the Whiteboard plugin settings in bb."
  - `review-api/instructions.ts`: "the scratchpad can be turned on in
    Whiteboard Desktop Settings." becomes "… in the Whiteboard plugin settings
    in bb."
  - The disabled trace topic says capture is off in this bb plugin, with no
    pointer to Desktop: no setting turns it on. Uploaded trace quotes remain
    supported.
- **Tool wording.** bb has no Whiteboard Desktop. The reader is a Whiteboard
  tab on the calling thread. The agent boundary adapts six tool-description
  phrases, the same way it renames tool tokens (`BB_WORDING` in
  `src/server/lib/tools/rename.ts`). `guidance.ts` and the vendored catalog keep
  upstream's text. Two result strings change at their source. These wording
  changes keep tool names and the `desktopAvailable` field. The wording
  changes are:
  - "documents the user reads in Whiteboard Desktop" becomes
    "documents the user reads in the thread's Whiteboard panel"
  - "opens the new review in Desktop when it is available" becomes
    "opens the new review as a tab in the calling bb thread"
  - "When Desktop is available the review opens there" becomes
    "When called from a bb thread the review opens there as a panel tab"
  - "without taking over Desktop" becomes "without adding a thread tab"
  - "Discover whether Desktop is available" becomes
    "Discover whether a bb thread can show the review (desktopAvailable)"
  - "The prepared checkout path is on the authoring server." becomes
    "Pass the checkout's absolute path on the calling thread's machine.
    Whiteboard runs Git there through that machine's bb host."
  - `review-api/instructions.ts`: the scratchpad-off message drops
    "or Whiteboard Desktop is not running". bb always supplies the panel
    opener, so only the setting gates the scratchpad.
  - `review-api/http.ts`: the 500 error names `server-stdio.log` in the bb
    server's logs folder instead of Desktop's `main.log`. The browser and the
    agent may be on other machines than the server, so it names no path.
- **Hosts.** The server, the browser and a repository's checkout may be on
  three machines. Authored code adapts most of this (`host-io/`,
  `host-resolver.ts`, `status.ts`). These vendored edits remain:
  - `review-api/http.ts`: a `HostUnavailableError` (the checkout's host is
    not connected or did not answer) answers 503 with its message, which
    names the machine. The stack route passes the session's repository, so
    `gh` runs on the host that holds the checkout.
  - `review-api/local-data.ts`: finding a checkout for a pull request URL
    skips a candidate whose host is unavailable. When nothing matched and a
    host was unavailable, that host's error is thrown instead of the
    "No registered checkout" 404.
  - `review-api/local-data.ts`: each worktree watch passes the repository's
    Git common directory, so the host skips Git bookkeeping without guessing
    from a root's contents.
- **Status.** `whiteboard_status` reports bb's public app URL as `instanceId`
  (null when none is configured) and `home: null`. The server's loopback URL
  and data directory mean nothing on the agent's machine (`status.ts`).
- **`review_*` names stay.** A few upstream error strings still say
  `review_open`, `review_file` and similar. They are left byte-identical.
- **Not ported.** Sharing, telemetry, bug reports, the welcome and CLI install
  flow, trace storage, managed language workspaces and the Desktop window
  chrome. Sharing, telemetry, bug reports and trace storage are removed.
  Managed language workspaces keep a stub that reports nothing configured, and
  Home's empty state replaces the welcome page.
- **Trace capture** is off. `trace_quote` blocks and uploaded traces still
  render, and the Trace tab lists the uploaded traces.
- **Markdown** uses Docs' TipTap extensions and shared prose styles. Raw HTML
  stays literal, implicit URLs stay unlinked, code link marks and soft breaks
  follow upstream Whiteboard behavior. Markdown code fences have Docs' plain
  rendering. Standalone code blocks use bb's syntax highlighting.
- **Source trees.** Open a live file to browse it in File Editor. bb does not
  expose a tree-only navigation API, so the session topbar hides upstream's
  Source tree button. It also hides the dev.fast Discord button.
- **CSS confinement.** Upstream's desktop build wraps canvas CSS in
  `@scope (.review-canvas-root)`. The vendoring tool prefixes each rule with
  `:where(.review-canvas-root)` instead. It matches the same elements at the
  same specificity. The stylesheet stays cheap for WebKit recalcs in every
  thread view.
- **Faint text.** Upstream's faint ink (`--ink-faint`) uses bb's readback tier
  instead of the ghosted subtle tier. It covers counts, section numbers, lens
  headings and repository names. It reads at 5.0:1 on Monokai, where it was 2.4:1.
- **Collapsed headings.** A collapsed section's title recedes to the readback
  tier instead of upstream's ghost ink.
- **Focus rings.** Upstream drew none or a hairline. The accent ring sits
  outside the control, or inside where a box would clip it. The inside ring
  covers the Contents pill toggle, Contents links in the full-page rail, and
  resizers. These controls draw the accent focus ring:
  - Contents links and the Contents toggle
  - Section chevrons and diff settings
  - Icon buttons for tours and side-panel close
  - Add to chat and history-banner buttons
  - Side-panel resizers
- **Document chrome.** Authored rules in `src/app/styles/document.css` fit the
  document to bb's panels:
  - Below the 1360px rail threshold, the Contents pill docks in the topbar row,
    left of the tabs. It no longer floats over the first heading. The topbar
    reserves the pill's slot whenever the shell is narrower than 1360px, even
    without the pill. The tabs never shift across views or documents.
  - A closed Contents list leaves the Tab order. Choosing an entry moves focus
    to its heading.
  - Under 520px, Dismiss is icon-only and keeps its accessible name.
  - Markdown prose and tables share the heading and peek measure. Table cells
    keep words whole.
  - Consecutive code peeks keep upstream's 14px gap. Upstream spaces sibling
    peeks, but the API document wraps each block in `.api-document-node`, so
    they touched.
  - A peek that is loading or cannot resolve shows one muted row in its frame,
    styled like upstream's inline editor error. Its text names the file and
    range (rename row on `CodePeek.tsx`).
- **Single-commit sessions.** When the base and head pins are the same commit,
  the header shows one copyable commit chip instead of `X ← X`.
- **Diff tab.** In panels narrower than 900px, the Diff sidebar is capped at
  34% of the workspace, with a 200px minimum. The lens list shrinks to fit its
  rows. The tree's Viewed boxes are a bb addition. They match the lens rows'
  boxes. Space on a focused file row toggles them. Screen readers hear the
  row's checked state. Everything else restores Desktop behavior, including
  a diff list that scrolls on its own. The file tree follows the WAI-ARIA tree
  pattern:
  - One Tab stop
  - Arrow keys to move, expand and collapse
  - Home and End to jump
- **Flow diagrams.** `flow-graph.tsx` is a hand-edited row:
  - Inline flows are sized from their ELK layout. Height runs from upstream's
    box (560px down, 420px right) up to 1400px. The drawing no longer shrinks
    into a fixed box.
  - Node labels show in full on up to two lines. Edge labels draw in one layer
    above every edge.
  - The expanded view opens at zoom 0.85 or more, centered on the selected
    step. A pan to a step never pulls the drawing's edge in past the padding.
    That limit keeps the first step at the top of the stage, not mid-stage
    (`src/app/lib/flow-fit.ts`). The view has zoom and fit controls, pans on
    trackpad scroll, and pans to a step that is off screen. A reader's pan,
    drag, scroll or zoom stops automatic refits. Clicking a node does not.
    Animations honor reduced motion.
  - Flows with no code attachments hide the footer hint. Flows with no added,
    removed or modified node hide the color legend.
  - In canvases narrower than 1080px, a flow tour keeps its stage at 58% of the
    height. Sequence and database tours still hide their stage there, as
    upstream does.
- **Diagram tours.** `flow-diagram.tsx`, `diagrams.tsx` and `database-lens.tsx`
  import the tour shell from `src/app/components/diagram-tour.tsx` through
  a redirect row. Opening moves focus to the active step and makes the covered
  document inert. Closing returns focus to what opened the tour. When that is
  gone, as for a tour restored on reload, focus goes to the canvas. The shell
  takes Escape only from inside the tour. `review-components.tsx` (rename row)
  makes side panels and tours ignore Escape typed outside the canvas. Escape
  in bb's composer leaves them open.
- **ELK.** `src/app/lib/elk.ts` builds one shared ELK instance on the first
  layout. bb startup no longer boots ELK's runtime. `c4-layout-geometry.ts`
  reaches it through a redirect row. The bundle still includes ELK.
- **Home wording.** Home says Whiteboards where upstream says Sessions and
  reviews. This covers the heading, search, count, empty-search and
  empty-repository messages, Untitled whiteboard, Sort, Dismiss and Delete
  labels, and the Dismissed and row-menu labels. The change is an edit row on
  `review/app/src/review-home-view.tsx` (map `polish-home`).
- **Home Cmd/Ctrl+F.** Home's search shortcut listens on the canvas root, not
  the window. It fires only while focus is inside the Whiteboard. Elsewhere
  the key stays bb's find. Same edit row.
- **Back link.** The way back from a full-page session is an All Whiteboards
  button in bb's title bar (`navPanel` `headerContent`), not a row in the page.
- **Narrow Home table.** `styles/home.css` drops upstream's 840px table minimum
  at every width. Home never scrolls sideways, and the title column takes
  what is left. At a canvas width of 900px or less, the rules hide Head branch
  and narrow the dates to 120px. At 660px or less, they hide Created too. The rules
  depend on upstream's column order: PR, Title, Head branch, Created, Updated,
  actions.
- **Empty Home.** The welcome stub's primary action starts a new bb thread
  with the selected prompt (`navigate.toCompose`). Copy prompt is secondary.
  If bb's new-thread composer already has a draft, bb keeps it and does not
  insert the prompt. Use Copy prompt instead.
- **Add to chat.** Upstream's "Copy for Agent" copies Markdown context for an
  agent in another app. `agent-selection.tsx` and its spec import
  `src/app/bridge/agent-handoff.ts` instead of `copy-text.tsx`:
  - Rename rows change "Copy for Agent" and "Copying…" to "Add to chat" and
    "Adding…". The toasts become "Added to chat." and
    "Could not add the selection to chat."
  - Two more rename rows pass the route's `handoff` to the bridge, with the
    element the selection was made in.
  - The copy-context route (`http.ts`, hand-edited) answers `handoff` beside
    upstream's `text`: the selection alone, session ID, displayed version and
    title.
  - The bridge quotes the selection and inserts a pill from the plugin's
    `session` mention provider. The provider's search lists nothing. Resolve
    reads only the pill's `<sessionId>@<version>` ID. A send never waits on or
    fails because of the engine.
  - Upstream's copy-context assertions in `local-data.engine.test.ts` also
    check `handoff` through rename rows.
- **Dismiss.** Desktop closes a canvas when its session is dismissed. The full
  page returns to Home, where the session is listed under Dismissed. A thread
  tab the server did not record shows "Whiteboard dismissed." with Undo
  instead. So does a full page beside a focused thread pane.
- **Images.** The declared Sharp dependency decodes PNG, JPEG and WebP. A bounded
  JavaScript fallback retains PNG and JPEG support if native decoding is unavailable.
- **Fixtures.** Upstream block and legacy-review fixtures sit at their
  upstream-relative path under `src/shared/vendor/review/src/fixtures/`,
  because the vendored specs read them by filesystem path.

## Known check warnings

`bun run check` exits 0 with these accepted warnings:

- **Rule 8, type-only edges.** Vendored app and shared files import engine
  types from `src/server/lib/vendor/` with `import type` (`Snapshot`,
  `ActivitySnapshot`, `LeaseScope`, `ReviewProgress`, `LocalReviewData`). No
  runtime code crosses.
- **Rule 8, host package root.** Vendored `structural-diff.ts` in
  `src/shared/node/vendor/` imports `src/host/lib/package-root.ts`, which finds
  diffr. Only the host runs that file.
- **Rule 8, fixtures.** `fixtures/blocks/fixtures.ts` imports `node:fs/promises`,
  `node:path` and `node:url` for the specs. No app or server code imports it.

## License

MIT. The vendored dev.fast code is MIT under the dev.fast copyright. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for it and the bundled npm
assets.
