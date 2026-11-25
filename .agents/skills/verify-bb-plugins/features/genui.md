# GenUI

Generative UI renders an assistant reply's ` ```ui ` blocks as live components and its ` ```app ` blocks as sandboxed HTML apps. It also adds a **Gen-UI Gallery** page with every component's examples, three settings, the `bb genui` CLI, and two agent tools, `check_ui` and `ui_examples`, for threads a person reads. Inputs recompute in the page. Picks and Form edits are staged into the thread's composer, not sent. `Load(path)` and `Snippet(path, …)` read files from the thread's workspace, its thread storage, or `/tmp`.

## Sub-features

- `genui-gallery-index` lists every component by group under `Search N components`, with group chips and lazily mounted examples.
- `genui-gallery-search` opens a component search with `/` or the search button. Arrows move the selection, Enter opens it, and Esc closes the search.
- `genui-gallery-component` shows one component's examples at `/plugins/genui/gallery/<Component>`, and one example alone at `/plugins/genui/gallery/<Component>-<variant>`. It has a breadcrumb, a back button, and a chip row of the group's components.
- `genui-gallery-footer` puts **Source**, **Copy** and **Open** under each example. Source opens numbered source, the files the example reads, and its diagnostics.
- `genui-gallery-reload` reloads the example list with **Reload the examples**.
- `genui-gallery-answers` shows what a pick would put in the message: `Would go in your message` and `In a thread, your message would get`.
- `genui-gallery-thread` renders the Project components (`Changes`, `Commits`, `Threads`, `Environments`) against `?thread=thr_…`. Without it they say `<Component> needs a thread`.
- `genui-families` renders every catalog component in all 11 groups (Layout, Content, Data, Media, Inputs, Widgets, Project, Dev, Manage, Evidence, 3D) without a `This UI couldn't be rendered` card.
- `genui-fence-ui` renders a reply's ` ```ui ` block in the thread timeline. While the reply streams it shows a `Building UI` skeleton, then the last good render.
- `genui-fence-failure` replaces a closed block that does not compile with a `This UI couldn't be rendered` alert listing `line:col error: …` diagnostics.
- `genui-state` recomputes on Slider, Toggle and Choice changes with no model call, and keeps the changed values across a page reload.
- `genui-actions` runs the `Set`, `Copy` (toast `Copied`) and `OpenUrl` actions. A non-http `OpenUrl` renders the inline error `OpenUrl needs an http:// or https:// URL` instead of its button. `Send` is a pick, not an action.
- `genui-answers` stages Button and FollowUps picks and Form edits into the composer draft as `label: answer` lines, shows `In your message`, and folds the controls to a `Sent` line after the user sends.
- `genui-form` stages the whole Form on its first edit (one line per field; an empty field reads `none (options: …)` in the Gallery preview) and keeps it current on later edits. After sending, the fields stay read-only.
- `genui-load` shows a file's data through `Load("path")` and `Snippet(path, from, to)` for workspace-relative paths, `/tmp` paths and `$BB_THREAD_STORAGE/…`. Any other path fails with `Couldn't load <path>: only files in this thread's workspace, its thread storage or /tmp can be loaded…`.
- `genui-app` runs a closed ` ```app ` block in an `App` iframe, with **Full screen**/**Close full screen** and **Download as HTML**. An unclosed app shows as source.
- `genui-directive` renders the retired `::ui{id="…"}` directive. Only its two failure notices can be reached: `Invalid UI directive: …` and `UI unavailable (UI <id> not found): …`.
- `genui-setting-animations` turns all motion off with **Animations**. Blocks then carry `data-genui-motion="off"`.
- `genui-setting-web` turns off the server-side web fetches with **Web lookups**: ImageSearch, Map geocoding and tiles, Wikipedia photos, and https images. Components then show `Web lookups are off`.
- `genui-setting-repair` controls **Repair broken UI**. When on, a person's thread that goes idle on a reply with a broken ui block gets one agent-only repair prompt.
- `genui-audience` gives `check_ui`, `ui_examples` and the `# Inline UI` instructions only to threads a person reads: root threads, side chats, and `genui ask` trials. Worker threads with a parent get none.
- `genui-tool-check-ui` is the `check_ui` agent tool (`Checking UI` / `Checked UI`). It reports compile errors, unreadable files and the text version of a ui or app block.
- `genui-tool-examples` is the `ui_examples` agent tool (`Reading UI examples`). It returns gallery examples and signatures for up to 6 components.
- `genui-cli-render` is `bb genui render [thread]`. It prints the thread's last reply with its UI turned into markdown.
- `genui-cli-ask` is `bb genui ask <prompt> [--model] [--provider] [--title]`. It opens a trial subthread and prints its id.
- `genui-rpc-markdown` is the `render_markdown` RPC, the twin of `render`: any ui text against any thread, rendered as markdown.
- `genui-code-work` adds the `Inline UI for code work` section to threads a person reads, and swaps the Map example for a web-lookups-off note when **Web lookups** is off. Prove it with a fake turn whose reply is `{{ECHO}}`. <!-- unverified: added from a source audit, not driven -->
- `genui-video-route` serves the Video player script at `/api/v1/plugins/genui/http/video-player.js`, with an ETag and 304 responses. `curl -s -D - -o /dev/null "$URL/api/v1/plugins/genui/http/video-player.js"` returns `200`, `text/javascript`, and an `etag`; the same request with `If-None-Match: <etag>` returns `304`.

## How to get to it (user POV)

- **Gallery:** the sidebar's **Gen-UI Gallery** nav entry (under **More** in live's mirrored navigation, where it is not pinned), or `$URL/plugins/genui/gallery`. Component pages are `…/gallery/<Component>`, examples `…/gallery/<Component>-<variant>`. Project components take `?thread=<thread-id>`.
- **Blocks in a thread:** open a thread at `$URL/projects/<project-id>/threads/<thread-id>` whose assistant reply contains a ` ```ui ` or ` ```app ` fence. Agents write these on their own once the plugin is on. A user message's fence stays a code block, because the renderer covers assistant messages only.
- **Settings:** **Settings → Plugins → Generative UI** (`$URL/settings/plugins/genui`) has **Animations**, **Web lookups** and **Repair broken UI**. The keys are `animations`, `webLookups` and `uiRepair`.
- **CLI:** `bb genui render [thread]` and `bb genui ask <prompt>`, from an agent's shell in a BB thread.
- **Agent tools:** `check_ui(spec, language?)` and `ui_examples(components)`, offered to person-read threads.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin genui`.
- **Gallery tier (free):** needs nothing else. It covers every component family and the inputs' gallery behavior.
- **Thread tier (free fake turns):** needs a thread whose last assistant reply holds the fixture blocks. No bb CLI or SDK call appends an assistant message directly, so use the local fake agent from SKILL.md **Free agent turns** (provider `acp-verify-fake`). It answers each prompt with the text of `$EV/reply.md` and logs every ACP message to `$EV/fake-agent.jsonl`. Copy a reply file to `$EV/reply.md` before each spawn and reset it to a plain line afterwards, because every later turn on that provider (a send from the composer, a repair prompt) answers with the same file. Never use a paid provider. Steps that need what a real model decides (calling `check_ui` or `ui_examples`) stay unverified.
- **Fixture project and reply files.** Commit them, because a worktree environment sees only committed files.

  ```bash
  FX="$BB_THREAD_STORAGE/verify/$RUN-fixtures"; mkdir -p "$FX/repo/data" "$FX/replies"
  git init -q "$FX/repo"
  printf '[{"name":"alpha","n":3},{"name":"beta","n":5}]\n' > "$FX/repo/data/rows.json"
  printf 'line one\nline two\nline three\n' > "$FX/repo/notes.txt"
  git -C "$FX/repo" add -A && git -C "$FX/repo" commit -q -m init
  printf '{"verify":"tmp"}\n' > /tmp/verify-genui-tmp.json   # /tmp is one of Load's roots
  "$TB" project create --name verify-genui --root "$FX/repo" --json | jq -r '.project.id // .id'
  ```

  Write each reply file below to `$FX/replies/<name>.md`. A reply is prose plus the fence. Each block below compiles with the plugin's own compiler, except `broken.md`, which is meant to fail. A closed block that does not compile shows only the failure card.
  - `ok.md`, three fences:

    ````
    Fixture.
    ```ui
    $seats = 10
    $on = false
    rows = Load("data/rows.json")
    Card("Verify estimate", [
      Row([Slider($seats, 1, 50, label: "Seats"), Toggle($on, label: "Annual")]),
      Metric("Total", "$" + fmt($seats * ($on ? 10 : 12))),
      Table(["Name", "N"], rows.map(r => [r.name, r.n])),
      Snippet("notes.txt", 1, 2),
      Text(Load("/tmp/verify-genui-tmp.json").verify),
      Button("Copy it", Copy("verify-copy")),
      Button("Set 40", Set($seats, 40))
    ])
    ```
    ```ui
    Card("Links", [Button("Bad link", OpenUrl("ftp://example.com")), Button("Good link", OpenUrl("https://example.com"))])
    ```
    ```ui
    $who = ""
    Card("Questions", [Form([Choice($who, ["Everyone", "Waitlist"], label: "Who should get it?")]), Button("Use Redis"), Button("Short label", Send("The longer answer text")), FollowUps(["Plan it hour by hour", "Compare Porto"])])
    ```
    ````

  - `broken.md`: a ` ```ui ` fence holding `Card("x", [Nope(1)])`. It fails with ``1:12 error: `Nope` is not a component, action or function. Did you mean `Code`?``.
  - `outside.md`: a ui fence holding `Card("x", [Text(Load("/etc/hostname"))])`.
  - `storage.md`: a ui fence holding `Card("x", [Text(Load("$BB_THREAD_STORAGE/verify.txt"))])`. Write `verify.txt` into the thread's storage directory, `$INST/data/thread-storage/<thread-id>`, after the spawn.
  - `app.md`: ` ```app ` holding `<button onclick="genui.answer('picked')">Pick</button>`.
  - `directive.md`: two lines, `::ui{id="abcdefghij"}` and `::ui{id="BAD"}`.

- **Spawn one thread per reply file.** Each spawn runs one free fake turn in a checkout environment:

  ```bash
  : > "$EV/fake-agent.jsonl"
  cp "$FX/replies/ok.md" "$EV/reply.md"
  "$TB" thread spawn --project <project-id> --provider acp-verify-fake --environment "$FX/repo" --title "verify-genui ok" --prompt hello --json | jq -r '.thread.id // .id'
  "$TB" thread wait <ok-thread-id>
  echo "verify fake agent: ok" > "$EV/reply.md"
  ```

  Repeat for `outside.md`, `storage.md`, `app.md`, and `directive.md`, recording each id. Spawn `broken.md` only in the repair step.

Gallery tier:

- **Index.** Run `agent-browser --session "$RUN" open "$URL/plugins/genui/gallery"` and `agent-browser --session "$RUN" wait --text "components," --timeout 20000`. The snapshot has heading `Gen-UI Gallery`, buttons `Search N components` (`Search 89 components` on 2026-11-24) and `Reload the examples`, and a `Groups` navigation with eleven chips in this order: `Layout`, `Content`, `Media`, `Data`, `Inputs`, `Widgets`, `Project`, `Dev`, `Manage`, `Evidence`, `3D`. Each group is an `h2` with one `h3` per component. Record N from the label; do not assert a fixed count.
- **Search.** Press `Escape`, then `agent-browser --session "$RUN" press /`. A combobox `Search components by name, group or what they show` and a listbox `Components` appear. Before typing, the listbox starts with `option "Card"` selected. Type `agent-browser --session "$RUN" keyboard type "Chart"`: the only option is `Chart Series: numbers or …` (name plus signature), selected. Press `Enter` and run `agent-browser --session "$RUN" wait --url "**/gallery/Chart" --timeout 10000`. A level-1 heading `Chart` shows in a `Breadcrumb` navigation, with `Back to all components`, a `Search components` button, and a `Data components` chip row (`Table`, `Chart`, `Sparkline`, …). Press `/` and then `Escape`: `listbox "Components"` leaves the snapshot.
- **Component and example pages.** On `/gallery/Chart`, each example sits in `[data-gallery-entry="<Component>-<variant>"]` (the first is just `Chart`), which holds a group named `Chart, <Variant>` and a footer with the file name (`Chart-funnel.ui`) and buttons `Source`, `Copy`, `Open`. Take the refs with `agent-browser --session "$RUN" snapshot -i -s '[data-gallery-entry="Chart-funnel"]'` and click `Open` by ref. Run `wait --url "**/gallery/Chart-funnel"`. The breadcrumb reads `Data` / button `Chart` / heading `Funnel`, and the back button is `Back to Chart`. Choose it: the URL returns to `/gallery/Chart`. Choose `Back to all components`: the URL is `/gallery`.
- **Footer.** Choose **Source** under `Chart-funnel` by ref. It reports `expanded=true` and a region `Source of Chart-funnel.ui` appears with numbered source lines (visible in a screenshot; the code text is not in the region's `textContent`). For a Load example, open `/gallery/Tests` and choose Source under `[data-gallery-entry="Tests-junit"]`: the region `Source of Tests-junit.ui` also shows `Files` `Load` `gallery/data/pytest-junit.xml`. **Copy** gives toast `Source copied` (headless Chrome allowed the write); read it with `agent-browser --session "$RUN" eval '[...document.querySelectorAll("[data-sonner-toast]")].map(t => t.innerText)'`. Where the browser denies clipboard access it reads `Couldn't copy the source: …`.
- **Reload.** Choose **Reload the examples** on the index. The examples remount and `Search 89 components` is back in the snapshot.
- **Gallery answers.** Open `$URL/plugins/genui/gallery/Button` and run `agent-browser --session "$RUN" find role button click --name "Run the e2e suite first"`. Two statuses appear, `Would go in your message` and `In a thread, your message would get`, the second with the paragraph `Run the e2e suite first`. `find role button click --name "Copy branch name"` gives toast `Copied`. On `/gallery/FollowUps`, choose `Where can we save the most?`: the button gets `aria-pressed="true"` (read it with `eval`; the compact snapshot omits it) and the preview shows the text. Choose it again: the preview statuses disappear. On `/gallery/Form`, the snapshot shows `radiogroup "Who should get it?"` with radios `Everyone` (checked), `Waitlist`, `Beta testers` and checkboxes `Email`, `Push`, `In-app`. Click radio `Waitlist` by ref. The preview reads `Who should get it? Waitlist` and `Which channels? none (options: Email, Push, In-app)`.
- **Family sweep.** Read the names per group from the index with `agent-browser --session "$RUN" eval 'JSON.stringify([...document.querySelectorAll("h2")].map(h => [h.textContent, [...(h.closest("section") || h.parentElement).querySelectorAll("h3")].map(x => x.textContent)]))'` (drop the sidebar's `Next Action` entry). For each name, run `agent-browser --session "$RUN" open "$URL/plugins/genui/gallery/<Name>"`, then `agent-browser --session "$RUN" wait --fn 'document.querySelectorAll("[data-gallery-entry] [role=group]").length > 0' --timeout 30000`, and `agent-browser --session "$RUN" eval '[...document.querySelectorAll("[role=alert]")].filter(e => /couldn.t be rendered/.test(e.textContent)).length'`. Each prints `0`. On 2026-11-24 all 89 pages rendered with no failure card; only `Changes`, `Commits`, `Threads`, and `Environments` showed `needs a thread`, and `Scene` and `Shader` rendered without a WebGL notice. Save the loop as a script under `$EV`: one page takes 5 to 15 seconds, so the sweep takes 10 to 20 minutes on a loaded machine. Screenshot one component per group to `$EV/gallery-<Name>.png`.
- **Project components.** Open `$URL/plugins/genui/gallery/Changes` with no query string: each example reads `Changes needs a thread: in a reply it lists the files changed in that thread's checkout.` Open it again with `?thread=<thread-id>`. For a scheduled thread (no environment), `Changes` and `Commits` read `This thread has no environment`, `Threads` reads `Subthreads 0 … This thread has no subthreads.` (its `Ids` example lists `thr_example001 Not found in this project`), and `Environments` reads `This project has no environments.` A thread with a checkout lists changes or `No uncommitted changes.` <!-- unverified: not driven with a checkout thread --> `Plugins` needs no thread: it lists `Generative UI genui v<version>` with its reload state, `Running · path · <source path>`, and other recently reloaded plugins.

Settings:

- **Animations.** Open `$URL/settings/plugins/genui` and wait for `Animations`. The page is headed `Generative UI` with switches `Disable genui` (leave it), and under `Configuration`: `Web lookups`, `Animations`, `Repair broken UI`, all `checked=true` by default. Run `agent-browser --session "$RUN" find role switch click --name "Animations"`. `"$TB" plugin config genui --json | jq .values.animations` prints `false` (poll it for a few seconds; on a loaded host the write lands after the click returns). Open `/gallery/Card`, wait for an entry, and run `agent-browser --session "$RUN" eval 'document.querySelector("[data-genui-motion=off]") !== null'`, which returns `true`. Switch it back on; the same probe on `/gallery/Card` returns `false`.
- **Web lookups.** With lookups on, write `{"query":"lisbon"}` to `$FX/q.json` and run `"$TB" plugin rpc call genui web_search --input-file "$FX/q.json" --json`: it returns `{"ok": true, "image": {"url": "https://thumb.wikimedia.org/…", …, "license": …}}` from Wikimedia Commons. Switch **Web lookups** off and confirm `jq .values.webLookups` prints `false`. The same call returns `{"ok":false,"error":"Web lookups are off in the Generative UI plugin settings","off":true}`. `/gallery/ImageSearch` shows `Photo of "<query>": not shown, because web lookups are off in the Generative UI plugin settings.` in place of each image. Switch it back on. `web_search` and `render_markdown` are not discoverable (`plugin rpc list genui --json` prints `[]`), but `call` reaches them.
- **Repair broken UI.** With the setting on (the default), truncate the log (`: > "$EV/fake-agent.jsonl"`), copy `broken.md` to `$EV/reply.md`, spawn a fake thread from it, wait for idle, wait about 15 seconds, and wait again. `grep -c '"session/prompt"' "$EV/fake-agent.jsonl"` prints `2`: the first prompt and one repair prompt, which begins `Your last reply has ```ui blocks that don't render; the user sees an error card or a partial block in their place:` followed by `Block 1:` and the `1:12 error: …` diagnostic. `"$TB" thread log <id> | grep -c '── User'` prints `1`, because the repair prompt is agent-only, and the thread has two `turn/completed` events. The fake answers the repair with the same broken block, and no second repair follows. Reset `reply.md`. Switch the setting off (`"$TB" plugin config genui set uiRepair false`), repeat with a new thread: the log shows one `session/prompt`. Restore the setting.

Thread tier:

- **Render.** Open `$URL/projects/<project-id>/threads/<ok-thread-id>`, run `agent-browser --session "$RUN" wait --text "Verify estimate" --timeout 30000`, and choose `Hide right panel` if a terminal panel is open. The fences mount after the card text, so wait on them rather than on `wait --text`: `agent-browser --session "$RUN" wait --fn 'document.querySelectorAll("[data-genui-fence]").length === 3' --timeout 30000`. The first fence's `innerText` reads `Verify estimate Seats 10 Annual Total $120 Name N alpha 3 beta 5 Source: data/rows.json notes.txt L1–2 tmp Copy it Set 40`. The Snippet's two lines (`1 line one`, `2 line two`) show only in a screenshot; they are not in `innerText`. The snapshot has `slider "Seats"`, `switch "Annual"`, buttons `Copy it`, `Set 40`, `Good link`, `Use Redis`, `Short label`, `Plan it hour by hour`, `Compare Porto`, and `radiogroup "Who should get it?"` with radios `Everyone` and `Waitlist`.
- **Streaming skeleton.** The `Building UI` status shows only while a fence streams. The fake agent sends the reply in one chunk, so it cannot show it. <!-- unverified: needs a streamed reply -->
- **State.** Read the total with `TOTAL='(() => { const m = [...document.querySelectorAll("[data-genui-fence]")][0].innerText.match(/Total\s*(\$\d+)/); return m && m[1]; })()'` and `agent-browser --session "$RUN" eval "$TOTAL"`. Toggle Annual from the keyboard: `agent-browser --session "$RUN" focus '[data-genui-fence] [role=switch]'` and `agent-browser --session "$RUN" press Space`. The switch reports `checked=true` and Total drops by a sixth (`$120` → `$100` at 10 seats) with no new turn: the event count from `"$TB" thread log <id> --json | jq length` is unchanged. Choose `Set 40`: Total becomes `$400` with Annual on, `$480` with it off. Reopen the thread: `slider "Seats"` still reads `40` and Total is unchanged.
- **Actions.** `agent-browser --session "$RUN" find role button click --name "Copy it"` gives toast `Copied` (read `[data-sonner-toast]`). An `OpenUrl` with a non-http link renders no button at all: the `Links` card shows the inline error `OpenUrl needs an http:// or https:// URL` in place of `Bad link`. `find role button click --name "Good link"` opens a new tab on `https://example.com/`; `agent-browser --session "$RUN" tab` lists it. Close that tab by its listed id and switch back to the first.
- **Answers.** Click by snapshot ref, after `scrollintoview` on the same ref: `Use Redis`, radio `Waitlist`, `Short label`, then `Plan it hour by hour`. The Questions fence then reads `… Waitlist In your message Use Redis Short label In your message Plan it hour by hour Compare Porto In your message`.
  - Read the draft with `agent-browser --session "$RUN" eval 'document.querySelector("[contenteditable=true]")?.innerText'`. It is `"Who should get it? Waitlist\nThe longer answer text\nPlan it hour by hour"`: the `Send` text replaces the label `Short label`, and the later button pick replaced `Use Redis`.
  - Set `$EV/reply.md` to a plain line, then send with `agent-browser --session "$RUN" find role button click --name "Submit (Enter)"`; this is a free fake turn. `"$TB" thread log <id>` shows the three lines as the user message. The Questions fence then reads `… Sent You sent: The longer answer text You sent: Plan it hour by hour`, and both radios report `disabled`.
- **Load outside the roots.** The `outside.md` thread shows `Couldn't load /etc/hostname: only files in this thread's workspace, its thread storage or /tmp can be loaded. Copy the artifact into $BB_THREAD_STORAGE on the thread's host and reference $BB_THREAD_STORAGE/<filename>; files on other machines must be transferred first`.
- **Thread storage.** The `storage.md` thread first shows `Couldn't load $BB_THREAD_STORAGE/verify.txt: file not found`. The thread's storage directory on the test host is `$INST/data/thread-storage/<storage-thread-id>`. Write `echo storage-ok > "$INST/data/thread-storage/<storage-thread-id>/verify.txt"`, reopen the thread, and `wait --text "storage-ok"` passes.
- **Broken block.** The `broken.md` thread shows an alert `This UI couldn't be rendered` with ``1:12 error: `Nope` is not a component, action or function. Did you mean `Code`?`` (twice when the repair turn answered with the same block).
- **App.** In the `app.md` thread the snapshot lists `Iframe "App"` and buttons `Download as HTML` and `Full screen`. `find role button click --name "Full screen"` turns the button into `Close full screen`; `press Escape` turns it back. Enter the frame by its snapshot ref, `agent-browser --session "$RUN" frame @<iframe-ref>` (the CSS form `frame 'iframe[title=App]'` reports `Could not find frame for selector` although the iframe's title is `App`), run `find role button click --name "Pick"`, and `frame main`. The block shows `In your message` and the composer draft is `picked`. Clear the draft afterwards (`focus`, `Control+a`, `Backspace`).
- **Directive.** The `directive.md` thread shows `UI unavailable (UI abcdefghij not found): ::ui{id="abcdefghij"}` and `Invalid UI directive: ::ui{id="BAD"}`.
- **Audience and tools.** After the root `ok` spawn, read the tools bb offered: `F=$(jq -r 'select(.message.method=="session/new") | .message.params.mcpServers[]? | .env[] | select(.name=="BB_ACP_DYNAMIC_TOOLS_FILE") | .value' "$EV/fake-agent.jsonl" | tail -1)` and `jq -c '[.[].name]' "$F"`. The list includes `check_ui` and `ui_examples`; read it right away, since the file is temporary. The tool names are not in the `session/new` line itself: the `bb-bridge` MCP server's env holds only `BB_ACP_DYNAMIC_TOOL_HOST`, `…_PORT`, `…_TOKEN`, `…_THREAD_ID`, and `BB_ACP_DYNAMIC_TOOLS_FILE`. `grep '"session/prompt"' "$EV/fake-agent.jsonl" | grep -c "# Inline UI"` prints `1`. Spawn a worker with `--parent-thread <ok-thread-id> --parent-notifications off` on a truncated log: its tools file has neither tool, and the `# Inline UI` count is `0`. Calling `check_ui` or `ui_examples` needs a real agent. <!-- unverified: the tool calls need a model -->

CLI and RPC:

- **render.** `"$TB" genui render <thread-id>` on a thread whose last reply is `ok.md` prints it as markdown: `**Verify estimate**`, `Seats: 10 (1–50)`, `Annual: off`, `Total **$120**`, the `Name | N` table with `alpha 3` and `beta 5`, `Source: \`data/rows.json\``, a `notes.txt:1-2`text block with both lines,`tmp`, `Options: Copy it · Set 40`, `_(error: OpenUrl needs an http:// or https:// URL)_`, `Who should get it?: — (Everyone, Waitlist)`, and a `Follow-ups:`list. An app block renders as`_Interactive app. Open this reply in BB to use it._`, and a directive stays as its `::ui{…}`line. The render reflects the reply, not the page's picks: send something after and the last reply changes. With no argument it exits 1 with`No thread to render (Pass a thread ID: bb genui render thr_…)`, because the wrapper unsets `BB_THREAD_ID`. An idle `--send-at`thread exits 1 with`thread <id> has no completed reply yet`. `render`takes no`--json` (`unknown option '--json'`).
- **render_markdown.** It needs no reply, only a thread id. Write `{"threadId":"<any-thread-id>","text":"```ui\nTable([\"Name\", \"N\"], [[\"alpha\", 3], [\"beta\", 5]])\n```"}` to `$FX/rm.json` and run `"$TB" plugin rpc call genui render_markdown --input-file "$FX/rm.json" --json`: it returns `{"markdown": "| Name | N |\n| --- | --- |\n| alpha | 3 |\n| beta | 5 |"}`. A spec that does not compile, such as `Card("x", [Nope(1)])`, comes back unchanged as a ` ```ui ` fence. Against a thread with no environment (any `--send-at` fixture), every `Load` and `Snippet` path, `/tmp` included, renders `_(error: Couldn't load <path>: only files in this thread's workspace, its thread storage or /tmp can be loaded. …)_`, so the allowed-path half of `genui-load` needs a thread with a checkout. Against a thread with a checkout (any fake-turn thread spawned with `--environment`), `Load("data/rows.json")` returns the two rows plus `Source: \`data/rows.json\``, and `Load("/tmp/verify-genui-tmp.json").verify`returns`tmp`.
- **ask.** It cannot be reached through `"$TB"`. Record it as unreachable: it needs `BB_THREAD_ID` of a test-instance thread, which the wrapper unsets. Through `"$TB"` it exits 1 with `ask runs inside a thread (Run it from an agent's shell in BB, where BB_THREAD_ID is set)`. Its proof needs a real agent's shell inside a test thread, because the fake agent runs no commands. `bb genui ask "hi" --provider <id>` prints a `thr_…` id, and `"$TB" thread show <that-id> --json` shows `parentThreadId` set to the caller. <!-- unverified: needs a real agent shell in a test thread -->
- **Proof.** Capture before and after each step to `$EV/genui-<step>.png`, and snapshots to `$EV/genui-<step>.snapshot.txt`.
- **Cleanup.** Remove only your fake-agent entry from `customAgents`, as SKILL.md **Free agent turns** describes. Restore `animations`, `webLookups` and `uiRepair` to their mirrored values. Run `"$TB" project delete <project-id> --yes`, then remove `$FX` and `/tmp/verify-genui-tmp.json`.

## Gotchas

- Picks persist in `localStorage` (`bb.genui.state:<message-id>#ui#<n>` and the thread's answer sheet). A re-run in the same browser session starts from the last values. Use a fresh thread or clear storage.
- Gallery answers never reach a composer. Only the preview text proves them. Composer staging needs a thread.
- **Repair broken UI** defaults on. A deliberately broken block buys a second turn; on the fake agent it is free but answers with the same `reply.md`, so the repaired reply is broken again.
- Suspected product gap: in a thread reply, a pointer click on `switch "Annual"` (`click @ref` or `find role switch click`) reports success but does not toggle it, and one attempt reported the click point covered by the Snippet's `diffs-container`. The same click toggles the Toggle on `/gallery/Toggle`, and `Space` or a DOM `.click()` toggles it in the thread. Use focus plus `Space` until it is fixed, and report it.
- The fake agent replays `$EV/reply.md` for every turn on its provider, including composer sends and repair prompts. Reset it to a plain line after each fixture spawn.
- A test-instance `sync` resets provider-acp `customAgents` to live's value, dropping your fake agent. Re-register it before the next fake turn.
- Headless Chrome may deny clipboard writes, so a `Copy` error toast is not a product gap. Assert the toast text.
- `OpenUrl` with an https link opens a new tab, or the Source Control review for a pull-request URL. Assert the tab or URL, not the toast.
- The Gallery mounts off-screen examples only when they scroll near. Use one component's page per check, not the index.
- Scene and Shader need WebGL. Headless Chrome may show `3D needs WebGL, which this browser has turned off`, which is an environment limit, not a render failure.
- Map, ImageSearch, Gallery-search and https Image examples call public services through the test server and fail offline.
- An idle `--send-at` thread has no environment, so `Load` refuses every path (workspace, `/tmp`, and thread storage alike) with the `only files in this thread's workspace…` message, and `?thread=` `Changes` and `Commits` read `This thread has no environment`. Use a thread that has run a turn.
- The machine running the verifier may be loaded by other agents: a `find role switch click` returns before the setting write lands. Poll `plugin config … --json` instead of reading it once.
- `bb genui ask` spawns a real agent turn when `BB_THREAD_ID` is set. Through `"$TB"` it only prints `ask runs inside a thread (Run it from an agent's shell in BB, where BB_THREAD_ID is set)` and exits 1; never run it from a shell inside a live thread during verification.
- `"$TB"` unsets every `BB_*` variable. Always pass the thread id to `genui render`.
