# How the plugin works

The internals behind [the README](../README.md): how agents learn the language, how blocks are mounted and kept stable, what each component reads, and where the code lives.

## From instructions to a rendered block

1. Sessions whose replies a person reads get four instruction sections from
   `instructions.ts`. Threads spawned by another agent get none, and neither
   do threads run by plugins other than side chat (for example workflows),
   except the subthreads `bb genui ask` opens to try a prompt.
   - `UI_REFERENCE` (the syntax; the Layout, Content, Data and Project
     signatures, generated from the catalog; when to write ```app) rides on
     the optional `check_ui` tool's instructions, and `UI_REFERENCE_MORE`
     (Inputs, Widgets, Media, Dev, Manage, the icon names) on the optional
     `ui_examples` tool's. BB places tool sections first.
   - `CODE_WORK_INSTRUCTIONS` (`bb.agents.contributeInstructions`) comes
     next: for each kind of engineering or management output, the command
     that saves it and the component that shows it, with examples, and the
     Evidence group's signatures (the reference sections are full). Replies
     after a task are where models fall back to pasted output and markdown
     tables. A contribution only gets the thread id, so it goes to the
     threads `configure` last chose; BB resolves `configure` first within a
     session's resolution.
   - `AGENT_INSTRUCTIONS` (`bb.agents.configure`) comes last, closest to the
     conversation. It says what the user wants shown (anything better seen
     or used than read) and that a markdown table, numbered steps, pasted
     code or an ASCII diagram is the wrong form for it; that the rest is
     prose in the agent's own words, never a lone sentence over a card; and
     that a block is skipped only when the whole reply is a few sentences
     with nothing to see, "in doubt, add the block". A shape list names a
     component for every kind of content. Only the message that ends the
     turn may hold a block: progress notes, thinking and tool input stay
     plain text, and nothing asks the user to decide mid-turn. Questions go
     in one Form or one run of Buttons (see 6 below). "Read in BB, not a
     terminal" is there for Claude Code, whose own system prompt says replies
     show as markdown in a terminal. Examples here are what moves models:
     the same calculator example stopped being followed when it sat in an
     earlier section. While web lookups are off, `AGENT_INSTRUCTIONS_WEB_OFF`
     swaps the Map example for a line saying so.
   BB refuses a tool whose instructions pass 4,096 characters (the plugin
   then fails to reload) and truncates the other sections there;
   `instructions.test.ts` fails the build past that and compiles every
   example. The four sections and the two tools cost 6,432 input tokens
   per session (measured against a session without them); about 42% is the
   component signatures, 42% the guidance. Formats a component can Load are
   listed once, in the code-work section, not again in its summary. BB's
   acp provider sends the instructions again, with every other plugin's,
   each time it starts a new agent process for the thread, and earlier
   copies stay in the context until it is compacted.
2. The agent writes the UI inline in its reply, so a UI costs no extra model
   call:
   - ```ui blocks use the spec language, whose components are listed in
     `core/catalog.ts`.
   - ```app blocks hold a self-contained HTML document, for things the
     components can't express. The reference line says what the page can
     rely on; `ui_examples(["app"])` returns the whole contract (`APP_GUIDE`
     in `examples.ts`) and the example pages in `gallery/app/`, which
     `core/appLint.test.ts` keeps lint-clean.
   - `check_ui` is optional: it compiles a block with its files loaded and
     returns the errors (wrong Snippet ranges, unreadable files) and the
     text version of what the user will see. It also tries the block's
     inputs the way a reader would (`core/probe.ts`, at most 24 per
     block, each from the initial state): sliders and steppers at both
     ends, toggles flipped, every option picked, lists emptied and
     filled, text cleared, Set buttons pressed. An error one of them adds
     is reported as `After setting $n to 0: …`, so a block that only
     breaks on the first drag is fixed before the reader sees it.
     `gallery.test.ts` runs the same probes over every example. For an app
     (`language: "app"`, or a spec starting with `<`) it runs
     `core/appLint.ts` instead, server only since it uses `node:vm`:
     classic scripts are compiled without running, so syntax errors and
     top-level await are reported at the app's own lines; network use is
     an error; dialogs, links that can't open, indexedDB, `genui` calls
     outside a function and 100vh heights are warnings. Only errors set
     `isError`. Apps may be 100,000 characters; ```ui specs keep 20,000.
   - `ui_examples` is optional: it returns the gallery examples of the
     components named (`examples.ts`), with their data files; "app"
     returns the app guide.
3. Rendering depends on the BB version:
   - With BB's merged `experimental_codeFenceRenderer` slot (#5387), BB
     hands each fence to `ui/SlotFence.tsx` with `code`, `language`,
     `status: "streaming" | "closed" | "unclosed"`, a per-language index
     and its message identity. Closed means the delimiter arrived; unclosed
     means the reply ended without it. UI finalizes diagnostics for either
     terminal status. Unclosed apps render `Original`, never partial HTML.
     BB keeps the renderer instance through streaming, closure and reply
     completion. Missing, disabled, conflicting or crashing renderers fall
     back to BB's code block; a crash is retried when code or status changes.
     The props are the SDK's `ExperimentalCodeFenceRendererProps` (0.6.54);
     `app.tsx` checks the method exists at runtime, since BB 0.45 lacks it.
   - On a BB without that slot, an app overlay (`ui/FenceOverlay.tsx`) finds
     the code blocks in BB's DOM, hides them and portals the same `Fence`
     there. It treats a block as complete after 1.5 seconds without a text
     change, so a paused or interrupted app can execute on this legacy path.
     Each mount carries `data-bb-plugin`, so BB's scoped plugin
     CSS applies.
   - BB's timeline unmounts rows that scroll out of view and remounts them
     on the way back, so a block must open at its final height or the
     conversation moves under the reader. The overlay renders a block it
     finds in the same task as BB's DOM change, before the browser paints
     (`flushSync` in its MutationObserver; streaming text is batched every
     60 ms). A remounted block reuses what it had: files and its images
     already read in this page (`useLoadedData`), its settled state, an
     app's last height, a diagram's last drawn height at that width (kept in
     `localStorage`), and no replayed entrance. A diagram holds that height
     exactly until BB draws it (BB draws a Mermaid block only within 256 px
     of the screen); one never drawn on this device keeps the tallest of its
     placeholders, so it moves once, when it draws. BB's code viewer shows a
     fixed skeleton while it highlights and then draws code at a height set
     by its line count alone (no wrapping), so a Code or Snippet body holds
     the height that many lines took on this device (`ui/codeHeight.ts`,
     learned from code the viewer drew, in `localStorage`) until the
     pulsing placeholders are gone. A block opened on a fresh
     page (the app started, the plugin reloaded) holds the height it last
     settled at, at that width (`ui/reservedHeight.ts`, also in
     `localStorage`), until the files and images it reads arrive and its
     pictures decode, however long a remote BB takes (a picture the browser
     can't decode isn't kept for the page, so the next mount reads it
     again); a component waiting for a `Load` is a quiet
     placeholder, never an error line. PullRequest's placeholder has its
     body's layout; list-shaped Project components (Changes, Commits,
     Threads, Environments) can't know their length before BB answers, so
     on a first view they grow once. An Image is laid out at the natural
     size its picture last decoded at (kept in `localStorage`; not for SVGs,
     which lay themselves out) before the picture arrives, and a reply seen
     answered folds its choices on the first frame instead of when BB's
     outline is read again (`ui/useSuperseded.ts`); until the outline says,
     the block remembers no height. Height glides (`useSmoothHeight`) only
     follow the user's own input; anything else snaps. `scripts/scroll-jitter.mjs`
     measures it. Both paths mark mounts with `data-genui-fence` and
     `data-genui-renderer="slot" | "overlay"`; the script reports mount
     counts and hidden code blocks as well as drift. Only the overlay adds
     `data-genui-hidden`. Persistent keys remain
     `bb.genui.state:${message.id}#${language}#${index}` on either path.
4. ```ui specs render while the reply streams: `compileStreaming` renders
   the longest prefix that compiles, cutting after each finished string
   too, so `Metric("Total", "$"` shows while `+ price` is still coming. A
   string still being written on the last line is closed where it stops
   when it is prose (Text, Callout, Card titles, table cells, step details),
   so a paragraph grows instead of appearing whole at its closing quote, and
   an open `**` or code span in it is closed too, so the run is styled from
   its first word instead of flipping when the closer arrives (after Zeron's
   `mend`). Paths, place names, image queries, icons, tones and labels a
   tap would send wait for their closing quote. What mounts while a block
   streams only fades, never moves, for three times the average gap between
   appends (120–400 ms, after Zeron's `veil`); the rise and stagger are for
   blocks that open complete and for what the user's input reveals
   (`ui/components/motion.ts`). Entrances, height glides, smooth scrolls
   and 3D hold still when the system asks for reduced motion or the
   `animations` setting is off (`reducedMotion()`; a Scene or Shader draws
   one frame). With the setting off, each block, placeholder and portal also
   carries `data-genui-motion="off"`, under which `app.css` stops every CSS
   transition and animation; the system setting reaches CSS only through
   `motion-reduce:` variants. The page reads the setting with `useSettings`,
   live, and keeps it in `localStorage`, since BB answers after a fresh
   page's first blocks have mounted. On the slot path,
   ```app blocks run only after the closing delimiter; the overlay uses the
   settlement heuristic above. Until then a preview frame
   (`sandbox="allow-scripts"`) draws the markup written so far:
   `core/partialHtml.ts` drops an unfinished tag or entity and every
   `<script>` and keeps complete `<style>` blocks, the host posts the result
   at most every 300 ms, and the frame's own bootstrap morphs its body in
   place (drawn nodes keep their identity), stripping inline handlers,
   `javascript:` URLs and embedded frames. The finished app opens under the
   preview at its height and replaces it once loaded. Apps run in an
   `<iframe sandbox="allow-scripts allow-forms">` with an opaque origin, a
   no-network CSP (with `form-action 'none'`) and BB's theme variables, and
   size themselves to their content; their heights go through
   `reservedHeight.ts` like a block's. BB's streaming-tail move preserves
   iframe documents where `Element.moveBefore` exists; elsewhere an iframe
   can reload once during settlement even though React state survives.
5. Interactions re-evaluate the spec locally, with no model call. State
   persists per block in `localStorage`. Inputs outside a Form are local
   what-if state and never reach the agent. Nothing the user picks is sent
   on its own: the thread's composer is the answer sheet
   (`ui/answerSheet.ts`, pure rules in `core/answers.ts`). A question is a
   run of choice Buttons (no action: the label is the answer; `Send(text)`:
   that text), a Form, a Plan's Approve, a Decision's option, a FollowUps
   prompt, the replying rows of a List, or a Findings, Dependencies or
   Pipeline action. Choices are single-select toggles (`aria-pressed`): a
   pick stages its answer, picking it again withdraws it, a sibling
   switches; a Set beside a Send runs at once. A Form's first field edit
   stages the whole Form as one `Label: answer` line per field
   (`core/form.ts`; a multi-select lists what was picked and what was not,
   `CSV, JSON (not: XLSX)`), typed fields after a 300 ms pause; there is no
   submit button, and `submit:` in old replies is accepted and ignored
   (catalog `legacy` params never reach a signature). Every block of a
   thread (each its own React root) stages into one module-level sheet per
   thread, which keeps one plain-text "answers block" in the draft: its
   entries in reply order (message by its place in the conversation
   outline, then fence, then document order in the block), one paragraph
   appended after what the user wrote, then replaced in place with
   `composer.replace`, moving the mention ranges after it and never touching
   the user's text; an empty sheet takes the block out. The sheet owns the
   range it wrote, not text that looks like it: each draft change is aligned
   against the last one (common prefix, and common suffix) and the range
   moves with text typed beside it; an edit inside it, a mention pill over
   it, or a change the two alignments place on different sides of it (the
   user pasted the same answer next to it) makes it the user's text, and the
   next change appends a fresh block. Only extra line breaks between its
   lines (an editor's paragraphs) leave it the sheet's, then and through
   later edits beside it; a TextArea answer's own blank line must stay. A
   change that takes the whole block out withdraws those answers (the
   composer is the truth for what will be sent), unless it empties the
   draft: BB submitting (`isSubmitting`) makes them sent at once; otherwise
   they stay staged until `onSubmitted`, the reply being superseded (the
   fallback for a composer that reports no submissions), or anything going
   back into the draft (text, a mention, an attachment) or a new pick, which
   makes it a deletion. A Form stages only on the user's own edit of a
   field, never because the sheet's entry differs from it; its typed answer
   waiting out the pause is written first on leaving the field, on Enter, on
   any press (BB's send button) and when BB starts submitting (those
   document listeners exist only while an answer is pending). It never
   focuses the composer or toasts; a muted "In your message" line marks a
   staged question. The sheet (entries, the block's range and the draft text
   it stands in) is read once per thread from `localStorage` and written on
   every change, so a reload, with the draft BB keeps, restores the picks.
   Windows on one thread don't merge: the last write wins, and a stale
   window can at worst append a duplicate block. The gallery shows what a
   pick would put in the message; only a thread with no composer on screen
   (or one without `replace`) sends a pick at once, and its Forms keep a
   Send button.
   A control whose action leaves the block says so
   (`ui/components/action-logic.ts`): a glyph at its end (`Sent` for an
   answer, `ExternalLink` for a link, `Copy` for a copy) and, on hover or
   keyboard focus, BB's tooltip (`components/ui/tooltip.tsx`, from the `@bb`
   registry) saying what pressing does now (`SendEffect`): an answer reads
   "Add to your message", "Take it out of your message" once picked, and
   "Send as your reply" where a pick is sent at once; a link shows what it
   opens and a copy what it copies. A text the control already shows isn't
   quoted again, unless the button's width cuts its label off (measured as
   the pointer arrives or focus lands); otherwise it is quoted, as a
   Decision's weights or a Form's answers. Links show the address the
   browser opens, without a user name or password, and one LiveUi won't open
   (not http or https) says so (`openableLink`, shared with LiveUi's
   OpenUrl). A quoted text's later lines are indented, so none reads as
   another action's line. A spec's `icon:` that is an action's glyph is
   dropped on a control that acts (a Button, a List row): the glyph at its
   end already shows it, or it would promise another action; a picked choice
   shows a check in front instead. Hints hold still under reduced motion.
   This covers Buttons (Decision's, Dependencies' and Pipeline's too), List
   rows, FollowUps, Form's Send, Plan's Approve, the Findings fix buttons,
   Entity's link, Waterfall's Open and Board cards. `Set` changes only the
   block, so it gets neither. A block shares one tooltip provider
   (`HintProvider` in LiveUi), so a neighbour's hint shows without waiting
   again. Hints take no pointer events and close as the pointer leaves. A
   control keeps the same tree with or without a hint, so an action that
   changes with state doesn't remount a focused button. Touch screens show
   the glyph only. Buttons that open a file in BB draw `FileText`, the File
   component's icon, so `ExternalLink` always means a web page. A row that
   names a file draws that icon once: a code frame's header ends with the
   open button (or leads with a plain icon where BB can't open the file), and
   a file listed as an item (a Findings group, a review artifact, Acceptance
   evidence) is itself the control that opens it.
6. Choices close once sent. Consecutive Buttons render side by side (a Row
   of Buttons too). When the user sends the draft (`composer.onSubmitted`)
   every staged answer becomes its block's sent answer (several per block,
   kept as `<stateKey>:answers`; a block's single `:answer` from before
   reads as one): a choice folds into one "sent" line, a Form turns
   read-only with "Sent". Once the thread has a user message after the
   reply (typed, or sent from anywhere), its open choices go away.
   `ui/useSuperseded.ts` reads that from BB's conversation outline and
   re-reads it only on thread events that can add a user message, so it
   holds for blocks BB has scrolled out of its timeline. A user row whose
   sequence is below one already listed doesn't count: BB's outline can put
   an old rejected steer at its end (`ui/supersession.ts`). Copy and link
   buttons stay.
7. A state declared with the wrong but losslessly convertible type
   (`$picked = ""` for a Checklist, `$n = "12"` for a Slider) is read as the
   type the input needs, with a warning instead of a failed block. The
   language also takes what models write anyway: named functions
   (`paid = p => sum($rows.filter(r => r.by == p).map(r => r.amount))`,
   called as `paid("Ana")`; no recursion, keys per call site) and object
   keys written as bare words (`{Good for: "views"}`). A style argument
   (`color:`, `background:`, `size:`…) is an error that says why:
   components draw in BB's theme, and `tone:` is the status colour where a
   component has one.
8. Data by reference: `Load("path")` reads a JSON (also `.sarif`, `.har`),
   CSV, TSV, JSONL or text file (a log, tsc output, lcov), and
   `Snippet(path, from, to)` reads lines of a file, so the model doesn't
   retype values or code. A loaded list may hold 20,000 items, so whole
   reports reach their component; a spec iterating one (`.map`, `.filter`)
   is still capped at 1,000. `Image(path)` loads png, jpg, gif, webp,
   svg or avif files (5 MB cap) through the `load_image` RPC. Paths are
   workspace-relative, `$BB_THREAD_STORAGE/…`, or absolute. Components that
   show code at a location their data names (a stack frame, a finding, an
   uncovered line) read the file through `runtime.readText`. A Scene's
   models, environments and textures (glb, gltf, hdr, png, jpg, webp; 10 MB
   cap) come through the `load_asset` RPC as bytes (`runtime.loadAsset`),
   decoded in the browser without fetching (glTF buffers and images
   included), since BB's CSP may refuse data: and blob: fetches. The backend
   (`data-source.ts`) only reads inside the thread's workspace, its thread
   storage and `/tmp` on the environment's host, where agents and their tools
   save screenshots and reports. BB refuses a symlinked root and macOS's
   `/tmp` is one, so `/tmp` paths are read through `/private/tmp` first.
9. Web lookups (`web/`), the plugin's only network access, run on the BB
   server, never in the browser, behind the `webLookups` setting (on by
   default):
   - ImageSearch and Gallery `{query}` items: the search words go to
     Wikimedia Commons (commons.wikimedia.org); the photo comes from
     upload.wikimedia.org, credited with its author and licence.
   - Map: names of places given without coordinates go to Photon
     (photon.komoot.io, one request a second); tiles come from
     tile.openstreetmap.org, whose tile coordinates reveal the area viewed.
     The map shows the OpenStreetMap attribution.
   - Map places with `wiki`: the title goes to en.wikipedia.org's page
     summary. Its lead image counts only when the original is on
     upload.wikimedia.org, the scaled copy (upload. or thumb.wikimedia.org)
     is the same Commons file, and Commons' extmetadata names an Artist and
     a CC or public-domain licence (`findWikiPhoto` in `web/commons.ts`, RPC
     `web_photo`, cached as `wiki:<title>`: 30 days for a photo, 1 for none).
   - Any https image (Image, Gallery, Entity, Hotspots) is fetched from the
     host in its link, through a proxy that refuses loopback, private,
     link-local and other non-public addresses (checked on the connected
     address and on every redirect), non-image bytes and files over 5 MB.
   Each service sees this machine's IP address, the request and a
   User-Agent naming the plugin; no cookies, thread text or account
   details. Answers are cached in the plugin's own database (up to 128 MB).
   Markdown renderings run the searches and Map photo lookups too and then
   link upload.wikimedia.org directly. Off: nothing is fetched, the
   components say so, and the instructions tell the agent.
10. An app's page gets, before the model's HTML, the bootstrap in
    `ui/appDocument.ts` (ES5 text that runs in the frame) and BB's base
    styles with the SVG kit: `t`/`ts`/`th` text, `box`, `arr`, `leader`,
    `tone-*` tints mixed from BB's tokens, and a `#genui-arrow` marker
    (WebKit has no `context-stroke`, so its arrowheads are drawn in the
    muted colour). The bootstrap fills the sandbox's gaps:
    - `localStorage` and `sessionStorage` are in-memory Storage objects (an
      opaque origin has neither). localStorage writes are posted to the
      host, debounced, and saved in its localStorage as `<stateKey>:storage`
      (256 KB per app; `bb.genui.appStorage` indexes them, 1 MB for all,
      oldest write evicted first); the next document starts with them.
      Gallery apps don't persist.
    - `alert`, `confirm`, `prompt` and `window.open` return what a sandbox
      would and post `blocked`, shown as a note under the app. Chromium
      fires no submit event without `allow-forms`, so the frame has it, and
      a capture-phase listener cancels every submit (Chromium lets a form
      navigate about:srcdoc despite `form-action`). A click on a link the
      app didn't handle is cancelled: https opens in BB, `#part` sets the
      document's hash (it would otherwise resolve against BB's address and
      load BB in the frame), anything else posts `blocked`.
    - The Animations setting reaches the frame in its config and live
      (`motion`): off, a style zeroes animation and transition durations,
      `genui.reducedMotion` is true and `matchMedia` answers the
      reduced-motion queries itself.
    - `genui.answer(text)` and `genui.openLink(url)` work only during the
      user's own gesture (`navigator.userActivation`, or a flag the
      capture-phase pointer, click, key and change listeners set for the
      current task). An answer goes to the thread's answer sheet as the
      block's question `"app"` through the hook ```ui blocks use
      (`useBlockAnswerTarget` in `LiveUi.tsx`), with the same "In your
      message" and sent lines.
    `ui/appBridge.ts` checks everything a frame posts against exact shapes
    (`height`, `error`, `storage`, `blocked`, `answer`, `openLink` with an
    https URL, `escape`); the host sends `theme`, `motion` and, to the
    preview, `preview`. Full screen makes the app's always-displayed
    `<dialog>` modal (`showModal()`): the top layer escapes any transformed
    ancestor without moving the iframe, so the app keeps its document, and
    an Escape the app doesn't handle is forwarded to close it. With BB's
    threads side by side or stacked, the dialog is placed over the app's own
    pane (`ui/paneBounds.ts`, from BB's `data-split-pane-id` markup) and the
    backdrop dims the rest; with one pane it fills the window. *Download as
    HTML* saves the same document built standalone: theme and current
    storage baked in, `genui.answer` a no-op, links opening a new tab.

## Components

`core/catalog.ts` is the single source of truth: the validator checks specs
against it, `ui/render.tsx` maps every entry to a renderer (a missing one
fails to typecheck), `core/markdown.ts` gives each a plain-markdown form, and
the instructions list it.

- Layout: Card, Row, Stack, Grid, Tabs, Details, Divider, Carousel
- Content: Text, Callout, Metric, Badge, Icon, KeyValue, Image, File,
  Entity (product, place or person card with a detail view), Sources, List
- Data: Table, Chart (bar, line, area, pie, scatter, radar, funnel,
  heatmap, histogram, box; stacked), Sparkline, Progress, Gauge,
  SegmentedBar, Steps, Timeline, Calendar, CalendarHeatmap, Tree, Code,
  Snippet, Diff, Diagram (mermaid, drawn in the Excalidraw style; nodes with
  `details` open an explanation when clicked; pinch or ⌘/Ctrl + scroll
  zooms it in place)
- Media: ImageSearch, Gallery, Map (days, Wikipedia photos, a tour),
  Hotspots
- Inputs: Slider, Stepper, Toggle, Choice (a vertical list when its options
  are long), Radio, Select, Checklist, ListEditor, Input, TextArea, DateInput,
  Rating, OptionCards, Swatches, EditableTable, FollowUps, Button (primary,
  secondary or red destructive; an optional BB icon in front, resolved
  against `ui/icons.ts`, and its action's glyph at its end), Form
- Widgets: Timer, Quiz, Flashcards, Walkthrough
- Project: Changes, Commits, PullRequest and Threads read the reply's
  thread's own state from BB (its checkout's diff, its branch's commits and
  pull request, its subthreads), so the model writes `Changes()` and no data;
  Changes and Commits keep a snapshot per reply (plugin storage), so an old
  reply keeps showing what it showed, with a Refresh. Threads also shows each
  thread's latest message, the question or approval it waits on, its model
  and reasoning level, and "Waiting on N running workers" for an idle
  parent. Tests renders a list, a vitest/jest JSON report or a JUnit XML
  report (`Load` reads `.xml` as JUnit), Json any value as a collapsible tree.
- Dev: the agent saves what a tool printed to `$BB_THREAD_STORAGE` and
  Loads it; each component knows that tool's exact format.
  - Logs: a log or command output (ANSI, levels from any common format,
    JSON-line records, filters, search, folded repeats, tail first).
  - StackTrace: an error and its causes in JS, Python, Java/Kotlin, Go,
    Rust, .NET, Ruby or Swift, with the code at the failing frame.
  - Findings: a review list, ESLint JSON, SARIF, `tsc` output, Ruff, oxlint
    or Biome JSON, with the code at each finding, tool fixes as diffs and
    "Fix this" / "Fix all"; a review's verdict and each finding's lifecycle
    (open, fixed but unconfirmed, confirmed, rejected with counter-evidence,
    deferred to an owner).
  - Coverage: istanbul summary, lcov, coverage.py JSON or Go profiles, with
    the uncovered lines shown in the code.
  - Dependencies: npm/pnpm outdated, npm/pnpm audit or pip outdated, grouped
    by semver bump and severity.
  - Pipeline: `gh run view` or `gh pr checks` JSON, or stages, with the
    failed step of a failed job.
  - Benchmark (before/after, hyperfine, vitest bench, every run of a
    repeated experiment; rows measured under different conditions read "not
    comparable"), Waterfall (spans, a HAR, a Chrome trace) and Treemap
    (sizes, an esbuild metafile, `du`).
- Manage: Board (a list, `bb tasks list --json`, `gh issue/pr list
  --json`), Roadmap (a Gantt), Status (project health), Plan (steps the
  user approves in one message), Decision (a weighted matrix whose weights
  the user tunes), Estimate (three-point, P50/P80/P90), and Environments,
  which reads the project's checkouts and worktrees from BB: branch,
  threads, uncommitted changes, ahead/behind and pull request.
- Evidence, drawn from the user's own BB history (claims without proof,
  visual parity disputes, wrong installed builds, speech errors):
  - Acceptance: criteria × conditions, each cell passed, failed, blocked,
    not tested or only claimed, with who checked and the evidence (code at a
    line, a file, a link, an image); a verdict and what needs the user.
  - Compare: a reference and a result image side by side, wiped, blinked
    or as a pixel difference with changed regions, zoomed together; it says
    when sizes or capture conditions differ.
  - Transcript: a reference and transcripts (whisper, whisper.cpp,
    Deepgram, AssemblyAI, SRT/VTT, timed words or text) aligned word by word,
    with WER, speaker errors and the recording, which a word click seeks
    (`load_audio`, 25 MB).
  - Provenance: the chain from source to what is installed or deployed,
    each stage with its facts and receipt; facts that differ from what was
    asked for, or between stages, are flagged, and the chain says where its
    receipts stop.
- 3D, matching Zeron's `ui.scene` and `ui.shader`: Scene draws objects
  (`{shape, ...}` records: solids with materials, surfaces, meshes, lines,
  points, labels, glTF models, an HDR environment, sprites) and Shader runs
  Shadertoy-style GLSL passes. A Scene's objects can be a function
  `t => [...]`, and a surface's `f` one of `(x, z)`: the language passes an
  arrow (or a named function by name) as a `FunctionValue` that closes over
  the evaluation and runs with its own step budget per call, so the renderer
  calls it every frame without re-evaluating the spec. `core/scene.ts`
  (`readScene`) checks every object strictly (an unknown field is an error
  naming the object) and fills Zeron's defaults, for the renderer and for
  evaluation, which reads the scene at t = 0; check_ui reads it again at
  t = 1.5, parses each shader pass with `core/glsl-check.ts` (errors by
  pass and line; server only, so the GLSL parser stays out of the page) and
  reports model, environment and texture files it can't read. The
  instructions carry one brief line; `ui_examples` returns the full API.
  Scene renders with three.js (`ui/components/sceneWorld.ts`): a key light
  with soft shadows on an invisible catcher, bloom from `glow`, physical
  glass with dispersion, PMREM environments, objects reused by index across
  frames. Shader is raw WebGL2 (`shaderGl.ts`) with float ping-pong buffers,
  Zeron's `light`/`alpha`/`opaque` blends, edge fade and a dither against
  8-bit banding. Both draw on a transparent canvas in theme colours
  (`gpu.ts` resolves tokens) and hold a WebGL context only near the screen,
  at most six at once, the rest showing their last frame as an image at the
  same height. On touch, vertical swipes keep scrolling the thread.

Table, Chart and Metric take `source:`, a catalog param flagged `unlisted`:
accepted, but left out of the signatures, since the reference states it once.
Without it, the evaluator adds `loadedFrom`: the plain-string `Load` paths a
static walk of the call's arguments reaches through named values, `$state`
initializers and named functions (`loadsReached` in `core/data.ts`, cached
per program). `RenderNode` draws either as a caption
(`ui/components/source.tsx`), never inside a table cell, and a stat strip
whose Metrics share one names it once; markdown puts `Source: …` under a
Table or Chart and after a Metric. Histogram and box statistics (type 7
quartiles, whiskers at 1.5 IQR, automatic bins at the finer of the
Freedman–Diaconis and Sturges widths rounded to 1, 2 or 5 × 10ⁿ) live in
`core/distribution.ts`, shared by the renderer and the markdown form.
`core/map.ts` reads Map's places for the component and its markdown alike:
a place without `day` stays on the previous one's day, which sets the
numbering, the list, each day's route and the tour, whose pace is
`tourStep` in `mapMath.ts` (six seconds over the stops, 300–1500 ms each).

What the user changes inside a component without a `$state` (weights,
unchecked steps, filters) is kept per block with `ui/usePersistedState.ts`,
so it survives BB remounting the row as the user scrolls. `ui_examples`
also says, for each tool-backed component, the commands that save the file
it reads.

Every picture a component shows (Image, ImageSearch, Gallery, Entity,
Hotspots, OptionCards, Compare, Acceptance and Provenance evidence) opens in
one full-screen viewer (`ui/components/viewer.tsx`): a press on the picture,
or, where pressing it already does something (Hotspots' pins, an option
card's selection, an Entity card's detail, Compare's wipe), an expand button
at its corner (Compare's in its zoom controls). The viewer fits the picture,
then zooms with the wheel, a trackpad pinch, two fingers or a double tap, and
pans by dragging; arrows, buttons or a swipe step through the component's
pictures; Escape, the close button, a tap beside the picture or a swipe down
closes it. Its caption is the picture's caption or alt, and an Image of a
file can be opened in BB from there. Like an app's full screen, it covers
only the block's own pane when BB shows several (a tap on the dimmed rest
closes it). Touch goes through touch events, not
pointer events, so a gesture the browser starts (a scroll under two
fingers) can't cancel it, and cancelling them is what keeps iOS from zooming
the whole page. The zoom and pan geometry is `zoomMath.ts`, shared with
Compare. Every surface a finger drags or pinches (the viewer, inline
diagrams, Compare, Map, an orbiting Scene or Shader) carries BB's
`data-no-sidebar-swipe` and `data-no-secondary-panel-swipe` (`NO_BB_SWIPE`):
BB's mobile swipes otherwise take a sideways pan, or the outer finger of a
pinch, and slide a panel over the thread, so the next drag never reaches the
drawing. An inline diagram draws its zoom again whenever BB replaces the
drawn block, so the zoom survives BB re-rendering the row.

Diagrams look like Excalidraw (`ui/components/sketch.ts`): Mermaid's
hand-drawn look in Excalifont on Excalidraw's palette, with decisions,
data stores, start/end points and events coloured by shape. Under BB's dark
theme the palette is Excalidraw's dark one, computed from its
`invert(93%) hue-rotate(180deg)` filter. A diagram has no frame or canvas of
its own: it is drawn on the card it sits in, its edge labels take that
colour (read from the page when it renders), and BB's diagram toolbar
(source, open, copy) is a quiet row of icons at its top right. Two fingers
or ⌘/Ctrl + scroll zoom it in place (one finger then pans it, and "Reset
zoom" fits it again); at its fitted size one finger scrolls the thread.
BB's open button shows it in the plugin's own full-screen view
(`DiagramViewer`), not BB's dialog, whose pinch listeners attach before the
dialog mounts, so on a phone it only pans; there a node with `details` opens
them in a popup over the drawing that folds to its title, and a tap
elsewhere dismisses the popup, not the view. A diagram that brings its own
front matter or init directive is drawn as written. The font's Latin subset
(25 KB, SIL Open Font License, `assets/fonts/`) is sent once per page by the
`sketch_font` RPC; diagrams wait up to 1.5 s for it, since Mermaid measures
text as it lays them out.

Every ChatGPT component the [OpenUI teardown](https://www.openui.com/blog/how-chatgpt-intelligent-ui-works)
describes has a counterpart, except the ones that need paid data services
BB doesn't have (product search, flights, news, stocks) and image or video
generation. Product and place cards (Entity) take their facts from the
model or from `Load` instead of a shopping search.

The Gen-UI Gallery page (`/plugins/genui/gallery`, in BB's sidebar) lists
every catalog component by group with its examples from `gallery/`
(`<Component>.ui`, `<Component>-<variant>.ui`), rendered as they appear in a
reply; `/gallery/<Component>` shows one component and `/gallery/<file>` one
example. One sticky header carries the navigation: on the index a search box
and the groups as chips (the group being read is marked; a tap jumps to it),
on a component's page back, where you are and the other components of its
group. Search (`/`, or the search button) opens a list under it: every
component by group, or the matches for a name, group, summary or example
variant ("kanban", "funnel"); arrows move, Enter opens. A component's page
starts with its summary and call signature from the catalog. Specs there Load and show files from
`gallery/` only. The same specs are what `ui_examples` returns, and
`gallery.test.ts` fails when a component has no example or an example
doesn't render cleanly.

## Clients

- **Web, desktop, mobile:** the BB mobile app is a WebView shell around the
  same web app, so it loads this plugin and renders the UI too. Checked in
  WebKit with iPhone emulation, including taps, sliders and the app iframe.
  Not run on a device.
- **CLI and SDK:** `bb genui render [thread]` prints the last reply with
  ```ui blocks rendered as static markdown (data loaded) and ```app blocks
  replaced by a one-line pointer. The `render_markdown` RPC does the same
  for SDK consumers. `bb thread output` still returns the raw source. In
  BB, `Frame` takes a `markdown` callback from `LiveUi`, and *Copy as
  markdown* (the reply's footer and the gallery's) copies
  `toMarkdownWithImages` of the current roots with the photos the page has
  already found (`foundImages`, `foundWikiPhotos` in `ui/webLookups.ts`);
  Project components copy their placeholder line.
- **Notifications and outlines:** BB's push previews skip fenced blocks. The
  instructions make the reply open with a plain answer sentence, so that
  sentence is what previews show.

The `::ui{id}` directive still renders UIs that the earlier `show_ui` tool
pilot stored.

## Layout

- `core/`: the spec language. It has a lexer, a parser, a validator against
  `core/catalog.ts`, a tree-walking interpreter with no `eval` (with step,
  node and list limits), and `compileStreaming`. It is pure TypeScript.
  `scene.ts` and `shader-args.ts` read the 3D components' arguments,
  `glsl.ts` builds shader sources and maps errors to the agent's lines, and
  `glsl-check.ts` checks shader GLSL without a GPU (server only).
  `partialHtml.ts` reads an app's streamed markup for the preview,
  `appLint.ts` checks app pages for check_ui (server only),
  `distribution.ts` holds the histogram and box statistics, `map.ts` reads
  Map's places and `source.ts` the data captions.
- `ui/`:
  - `Fence.tsx`: the shared renderer.
  - `SlotFence.tsx`: the native renderer slot, including terminal status policy.
  - `FenceOverlay.tsx`: the older-BB DOM fallback and settlement heuristic.
  - `AppBlock.tsx`: the sandboxed apps (preview, frame, toolbar);
    `appDocument.ts` their documents and bootstrap; `appBridge.ts` what a
    frame may post, and app storage in the host.
  - `components/`: one renderer per catalog component. Styling uses host
    token classes only.
  - `GalleryPanel.tsx`: the gallery page; `GalleryHeader.tsx` its title,
    search and component directory, with the search itself in
    `gallery-search.ts`.
- Backend:
  - `server.ts`: scopes the instructions and registers the tools, the RPCs
    and the `bb genui` CLI.
  - `data-source.ts`: the confined file loader, also for the gallery and the
    diagram font in `assets/fonts/`.
  - `web/`: web lookups (address-checked fetches, Commons search, Wikipedia
    lead photos, Photon, OSM tiles, the cache).
  - `fallback.ts`: renders replies as markdown; `examples.ts`: `ui_examples`.

## Develop

```sh
npm install
npm run typecheck && npm test
bb plugin build && bb plugin install .   # then: bb plugin reload genui
node scripts/gallery-shot.mjs Map --mobile   # screenshot gallery/Map.ui at 393 px
node scripts/gallery-shot.mjs Changes --thread thr_…   # examples that read a thread's state
node scripts/scroll-jitter.mjs thr_… [--off]   # how far a thread moves while scrolling, vs BB alone
bb genui ask "Plan a day in Lisbon"          # try a prompt in a subthread that gets the instructions
```

Instruction changes apply to provider sessions started after the reload.
