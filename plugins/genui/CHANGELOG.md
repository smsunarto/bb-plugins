# Changelog

What changed in each version of the Generative UI plugin for BB. Update an install with `bb plugin update genui`; agent sessions started after the update get new components and instructions.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.3.1] - 2026-10-22

### Fixed
- Code and Snippet stay drawn after their tab or Details is hidden and shown again. BB's code viewer left a blank box in their place when it came back (BB 0.46 ships @pierre/diffs 1.2.9, fixed upstream in 1.3.0); the plugin now makes a new viewer while it is hidden. Diff was not affected ([#12](https://github.com/ComicBit/bb-plugin-genui/pull/12)).

## [0.3.0] - 2026-10-22

### Added
- **Apps keep their state.** In a ```` ```app ```` block, `localStorage` works and is saved with the reply, so a game's best score or a tool's settings survive scrolling away and reloading the page (256 KB per app, 1 MB for all apps together, the oldest dropped first); `sessionStorage` works while the app is on screen. Before, both threw an error on first use in BB's sandbox.
- Apps no longer fail silently where the sandbox says no: `alert`, `confirm`, `prompt` and `window.open` show a short note under the app; forms run their submit handlers without reloading the app; an https link opens in BB, a `#part` link moves within the app, and other links say why they go nowhere.
- **Apps can answer.** `genui.answer(text)`, called from a click or key press, puts the app's answer in your message like any other pick; nothing is sent until you send. `genui.openLink(url)` opens an https page in BB.
- Apps follow the *Animations* setting (CSS motion stops, `prefers-reduced-motion` matches, `genui.reducedMotion` is true), open at the height they last had after a page reload, and draw their layout as it streams in instead of only "Building app…"; none of an app's scripts run until it is complete.
- Apps have *Full screen* and *Download as HTML* buttons at their top right.
- An SVG kit for diagrams drawn in apps: text, box and connector classes, `tone-good`, `tone-warn`, `tone-bad`, `tone-info` and `tone-accent` tints from BB's theme, and an arrowhead (`marker-end="url(#genui-arrow)"`).
- `ui_examples(["app"])` gives agents the app contract and two complete example apps. `check_ui` checks app pages (`language: "app"`, or by itself when the text starts with `<`): script syntax errors, top-level `await` included, at the app's own lines; anything that needs the network as errors; dialogs, links that can't open, indexedDB, `genui` calls outside a handler and `100vh` heights as warnings with the fix.
- **Copy as markdown** beside a reply's *Source* toggle, and *Markdown* in the gallery footer: the block as plain markdown with the values you changed and the photos already found.
- `Chart` types **histogram** and **box** for raw observations such as latencies or benchmark runs. A histogram's `labels` are its bin edges, or `[]` for automatic bins; groups stand side by side. A box plot draws one horizontal box per group with the median, whiskers at 1.5 IQR, outliers and n. Empty or non-numeric values are left out with a note.
- **Map trips.** A place can name a Wikipedia article (`wiki: "Belém Tower"`): its card shows the article's lead photo with author and licence, only when that Commons file has a named author and a Creative Commons or public-domain licence (looked up on en.wikipedia.org and Commons, behind *Web lookups*). Places can carry `day`: pins and cards get a colour per day, a legend and day headings, and a route joins each day's stops. `tour: true` drops the pins in order over about six seconds once the map is on screen, with Pause/Resume and Replay; it never scrolls the page or moves the map, and shows everything at once with reduced motion or *Animations* off. With a route, a caption says the line is not directions.
- **Where the numbers come from.** Table, Chart and Metric take `source:` (`"illustrative"`, `"user-provided"`, a note or an https URL), shown as a quiet caption and in the markdown version. When their data comes from `Load` and no source is given, the caption names the file and opens it on click; a row of Metrics from one file names it once.
- Buttons say what pressing them really does. A glyph at the end names the action: a paper plane for an answer, the external-link arrow when it opens a link, the copy icon when it copies. Hover or keyboard focus shows BB's tooltip saying it: `Add to your message`, or `Add “Open a PR for this branch” to your message` when the label doesn't show the answer; `Take it out of your message` once picked; `Send “…”` where a pick is sent at once; `Open https://…`; `Copy “fix/upload-race”`. A cut-off label is quoted. A link shows the address the browser opens, so `https://github.com@evil.com/` reads `https://evil.com/`, and a link that isn't http or https says it can't be opened. The later lines of a quoted text are indented, so none reads as another action. The tooltip holds still under the system's reduced-motion setting. This covers Button (with Decision's, Dependencies' and Pipeline's buttons), List rows, FollowUps, a Form's *Send*, a Plan's *Approve*, the Findings fix buttons, the Entity link, Waterfall's *Open* and Board cards ([#11](https://github.com/ComicBit/bb-plugin-genui/pull/11)).

### Changed
- **Your message is the answer sheet.** Nothing you pick in a reply is sent on its own any more. Choice buttons, a Form's fields, a Plan's *Approve*, a Decision's option, a follow-up and a reply row of a List go into your message box as one block of plain lines, kept up to date as you change them, beside anything you type; you send everything with BB's own send button. A reply that asks several questions, in one block or several, can now be answered in full: answering one no longer closes the others. Delete the block from your message to clear those picks; edit it and it is your text.
- Choices are toggles: a pick shows as selected, picking it again takes it back out, picking another switches. A muted *In your message* line marks a question that is answered in your draft. Picks survive a page reload.
- Forms have no submit button: your first change puts every field in your message as `Label: answer` lines. A checklist or other multi-select says what you picked and what you didn't (`Which formats? CSV, JSON (not: XLSX, PDF)`). Plans lost their note field: write changes in your message.
- After you send, every answered block folds into what it sent, several answers per block where it asked several questions.
- Replies written before this version still render: their `submit:` labels are ignored. Without a composer for the thread on screen, a pick is still sent at once, and a Form keeps a *Send* button.
- In the Gen-UI Gallery, an example shows what its picks would put in your message.
- **Agents show what is better seen than read, and write real prose around it.** The old instructions made agents put UI almost everywhere with one sentence above a card; the first rewrite fixed the prose but made blocks look optional, and agents fell back to markdown tables. The new text says what you want shown (numbers, comparisons, flows, code, tool output, dates, places, steps, practice, choices) and that a markdown table, numbered steps or pasted code is the wrong form for it; a block is skipped only when the whole reply is a few sentences with nothing to see, and "in doubt, add the block". Prose says what the block means, without recapping it. A list maps every kind of content to its component.
  On a 64-prompt battery built to need about 60 different components (2 runs each, headless), Haiku 5.5 now uses UI on 103 of 110 prompts that call for it (52 before, 99 with the oldest text) and the fitting component on 93; Sonnet 5.5 on 109 of 110, the fitting component on 102. Prose on those replies is about 120–165 words instead of 28–52, one-line-over-a-card replies fell from 74 to 3, and UI on questions that want a short answer fell from 6 in 36 to 2. A blind Sonnet judge preferred the new replies to the previous release's 181 to 67. In real BB threads (one run each), UI where the content calls for it went from 28 to 47 of 55 on Haiku, 47 to 54 on Sonnet and 28 to 46 of 54 on Claude Code, and the number of different components used from 29 to 41, 42 to 56 and 23 to 45.
- Claude Code sessions use UI as often as omp ones: Claude Code's own system prompt says replies show as markdown in a terminal, and the instructions now say replies are read in BB.
- UI belongs only in the reply that ends the agent's turn: progress notes while it works, thinking and tool input stay plain text, and it must not ask you to decide something while it keeps working (the cause of most UI found in progress notes). Questions go in one Form, or one run of buttons for an either/or, with no submit labels or answer texts written by the agent.
- The instructions cost 6,432 input tokens per session instead of 6,949 (measured against a session without them). Load formats are listed once, in the code-work section, instead of again in each component's summary; the icon list, the math function list and two lines that repeated the tools' own descriptions are shorter or gone.
- The reference sections grew by about 300 characters for `source:`, the histogram and box types, Map trips and the app line (not yet measured in a session).
- A Button's or a List row's own `icon:` stays in front and the action's glyph goes at the end, so a link keeps its arrow when it has an icon too. A send, link or copy glyph given as `icon:` only appears for that action, once ([#11](https://github.com/ComicBit/bb-plugin-genui/pull/11)).
- List rows and FollowUps that answer show the paper plane instead of the chevron or the arrow. Board cards that open their issue show the link arrow by the key, and BB's tooltip replaces the browser's ([#11](https://github.com/ComicBit/bb-plugin-genui/pull/11)).
- Buttons that open a file in BB show a file icon instead of the external-link arrow: Snippet, Changes, Tests, the code-health reports (Findings, Coverage, StackTrace, Acceptance and Provenance evidence), the picture viewer, and Compare when its image is a file. The arrow is left for web pages ([#11](https://github.com/ComicBit/bb-plugin-genui/pull/11)).
- A row that names a file shows the file icon once. A Findings file group, a review's artifact and Acceptance's file evidence open the file from their icon and path, and Provenance's file evidence has the header of a code excerpt ([#11](https://github.com/ComicBit/bb-plugin-genui/pull/11)).

### Fixed
- `Chart` series written as `{name: {values, tone}}` failed with "series needs a list of numbers", though the reference shows that form.
- A thread opened again (after a while, on a fresh page, or over a slow remote connection) no longer shows gaps under its pictures that then snap shut. A block BB mounts again shows the pictures it already read in this page instead of reading them again, an Image is laid out at its picture's last natural size before the picture arrives (Hotspots keeps its last shape the same way; SVGs still lay themselves out), and a block holds the height it settled at until its pictures arrive and decode instead of giving up after 4 seconds and remembering the placeholder's height. A picture the browser can't decode is read again the next time its block mounts ([#10](https://github.com/ComicBit/bb-plugin-genui/pull/10)).
- The choices of a reply already answered no longer show for a moment and then fold when a thread is opened again more than 10 seconds after it was left: answered replies are remembered across pages ([#10](https://github.com/ComicBit/bb-plugin-genui/pull/10)).
- A review artifact that is a web address opens as a link, with the link arrow, instead of showing as a file that can't be opened ([#11](https://github.com/ComicBit/bb-plugin-genui/pull/11)).
- Less movement under you when scrolling a thread full of cards, most of all on a phone:
  - A diagram drawn here before keeps its height exactly until BB draws it again. Before, its loading placeholder could be taller, so the card shrank twice: once when the font loaded, and again when the diagram came near the screen (BB draws Mermaid only within 256 px of it). A diagram never drawn here keeps its tallest placeholder, so it moves once, when it draws.
  - `Code` and `Snippet` open at the height their code will take. BB's code viewer shows a fixed 128 px placeholder while it highlights, so short code shrank (by 60–78 px for one or two lines) and long code grew (up to 256 px) once drawn. The plugin learns how tall each number of lines is from the code BB has drawn on this device; until it has seen two lengths, nothing is held.
  - `PullRequest()` opens at about its final height: its placeholder has the layout of the title, branches and three facts, instead of two short rows. On a 402 px phone a card holding it grew by 45 px instead of 217 px when GitHub answered.
- With threads side by side or stacked in BB, a picture, diagram or app opened full screen covers the pane of the thread it came from instead of the whole window across every pane; the rest of the window dims, and a tap there closes a picture or diagram.

## [0.2.6] - 2026-10-21

### Added
- An **Animations** setting, on by default, beside *Web lookups*. Off, nothing in inline UI moves: entrances, chart draws, height glides, smooth scrolls, CSS transitions and pulses stop, and 3D scenes and shaders hold a still frame. The system's reduced-motion setting is honoured either way.

## [0.2.5] - 2026-10-21

### Fixed
- Installing from GitHub (`bb plugin install git:github.com/ComicBit/bb-plugin-genui@^0.2.0` or the repository URL) failed since 0.2.0: BB installs only `dependencies` before building, and three.js and the GLSL parser were listed as dev dependencies, so the build couldn't find them. Both are now runtime dependencies.

## [0.2.4] - 2026-10-21

### Added
- This changelog.

## [0.2.3] - 2026-10-20

### Fixed
- A zoomed picture or diagram can be dragged in every direction in the full-screen viewer. Along a side where it was still smaller than the screen (a wide diagram zoomed on a phone, or any diagram zoomed a little on a large screen), it was kept centred and the drag was ignored. Zoomed back out to fit, it is centred again. Compare uses the same geometry.

## [0.2.2] - 2026-10-20

### Fixed
- Diagrams pan after a pinch on touch screens. BB's mobile sidebar and side-panel swipes took the gesture: the outer finger of a pinch, or a sideways drag, slid a panel over the thread. Every surface you drag or pinch now opts out of BB's swipes: diagrams, the full-screen viewer, Compare, Map, and Scenes and Shaders you can orbit.
- A zoomed diagram keeps its zoom when BB redraws the message.

## [0.2.1] - 2026-10-20

Not released separately on GitHub; included in 0.2.2.

### Added
- One full-screen viewer for every picture a component shows (Image, Gallery, ImageSearch, Entity, Hotspots, OptionCards, Compare, Acceptance and Provenance evidence): zoom with the wheel, a trackpad pinch, two fingers or a double tap; drag to pan; step through a component's pictures; close with Escape, the close button or a tap beside the picture. Where tapping a picture already does something, an expand button opens it.
- Diagrams pinch-zoom (or ⌘/Ctrl + scroll) in place, and open full screen in the plugin's own viewer, which zooms and pans on iOS too.
- The README carousel shows the 3D components moving.

### Fixed
- Some images couldn't be opened at all (an Image only opened for workspace files, and Entity, Hotspots, OptionCards and Provenance pictures never did), and none could be zoomed.
- Tapping a diagram node that has details in full screen opens its detail inside the full-screen view instead of closing it.
- Fallback widgets open links in BB's in-app browser with the right thread context ([#6](https://github.com/ComicBit/bb-plugin-genui/pull/6)).

## [0.2.0] - 2026-10-20

### Added
- **3D**, after [Zeron](https://github.com/zeronsh/zeron)'s `ui.scene` and `ui.shader`:
  - `Scene` (three.js): solids, surfaces, meshes, lines, paths, points with hover hints, labels, grids, axes, glTF models, HDR environments and sprites; materials with roughness, metal, glow with bloom, and glass with refraction and dispersion; soft shadows; drag to orbit, pinch or ⌘/Ctrl + scroll to zoom. `t => [...]` animates it frame by frame.
  - `Shader`: Shadertoy-style GLSL passes with feedback buffers, `iMouse`, an orbitable `iCamera`, `inputs` bound to state, textures and `iNoise`; `light`, `alpha` and `opaque` blends and bloom.
  - At most six WebGL contexts at once; the others show their last frame at the same size.
  - Math functions: `sin cos tan asin acos atan atan2 sqrt floor ceil clamp lerp range random`, `PI` and `TAU`.
  - Eight gallery examples.
- `check_ui` tries a block's inputs the way a reader would (slider and stepper ends, toggles, every option, emptied and filled lists, cleared text, Set buttons) and reports the errors one causes, e.g. `After setting $n to 0: …`. Scenes are checked at two times and every shader pass is parsed, with errors by pass and line.
- Style arguments (`color:`, `background:`, `size:`) explain why they are refused and point to `tone:`.
- `Chart` series take a tone: `{values, tone}`.

### Changed
- Text, callouts, table cells and step details grow as the reply streams, with an open `**` or code span styled from its first word. Paths, place names, icons and labels you could tap wait for their closing quote.
- Content that appears while a block streams only fades in, at the stream's pace (120–400 ms), and never shifts the conversation.
- Blocks render through BB's code fence renderer slot ([get-bb/bb#5387](https://github.com/get-bb/bb/pull/5387)) where BB has it; older BB keeps the DOM overlay. Built against `@get-bb/plugin-sdk` 0.6.54.
- The plugin's page code grows from 0.9 MB to 1.6 MB (three.js). The GLSL checker runs on the server only.

### Fixed
- An old rejected steer at the end of BB's outline no longer counts as an answer to a reply's buttons.
- Absolute thread-storage, workspace and `/tmp` paths a spec shows can be opened.

## [0.1.0] - 2026-10-11

First release: agents answer with ```ui blocks (86 components in 10 groups, from cards, tables and charts to maps, boards, roadmaps and quizzes), interactive without extra model calls, reading files instead of retyped numbers, and sandboxed ```app blocks for anything else.

[0.3.1]: https://github.com/ComicBit/bb-plugin-genui/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ComicBit/bb-plugin-genui/compare/v0.2.6...v0.3.0
[0.2.6]: https://github.com/ComicBit/bb-plugin-genui/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/ComicBit/bb-plugin-genui/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/ComicBit/bb-plugin-genui/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/ComicBit/bb-plugin-genui/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/ComicBit/bb-plugin-genui/compare/v0.2.0...v0.2.2
[0.2.1]: https://github.com/ComicBit/bb-plugin-genui/compare/v0.2.0...12acfd6
[0.2.0]: https://github.com/ComicBit/bb-plugin-genui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ComicBit/bb-plugin-genui/releases/tag/v0.1.0
