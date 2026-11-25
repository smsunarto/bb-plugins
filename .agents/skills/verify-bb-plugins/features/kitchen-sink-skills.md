# Kitchen Sink: composer skills and desktop companion

Kitchen Sink ships three composer skills: `/project-scripts` saves a repository's useful commands as project scripts in the thread context card, `/subthread` does the requested work in a linked BB child thread, and `/test-remotely` verifies the current work on a remote BB machine and returns screenshots or a demo. It also carries Clicky, an optional native macOS companion that answers held-hotkey voice questions through BB; installing the plugin does not launch it.

## Sub-features

- `ks-skill-list` lists `project-scripts`, `subthread`, and `test-remotely` as skills from Kitchen Sink.
- `ks-skill-slash` offers `/project-scripts`, `/subthread`, and `/test-remotely` in the composer's slash menu.
- `ks-skill-project-scripts` has the agent save scripts that then appear in the thread context card ([thread details](kitchen-sink-thread-details.md)).
- `ks-skill-subthread` spawns a linked child thread for the task; the agent never invokes it on its own, only the user does.
- `ks-skill-test-remotely` pushes the task branch and runs a remote child that returns reviewed evidence.
- `ks-companion` is the macOS menu-bar and notch companion: hold `⌃⌥Space` to ask, `⌘⇧Space` to stop and clear graphics.

## How to get to it (user POV)

- In any thread composer, type `/` and pick a Kitchen Sink skill, or type its name.
- Ask the agent to set up project scripts; it can load `/project-scripts` itself. `/subthread` runs only when the user types it.
- For the companion, build it on a Mac from the plugin's `companion` folder, then use its menu-bar icon for settings.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin kitchen-sink`.
- A fixture project and an idle thread exist, as in [thread details](kitchen-sink-thread-details.md).
- Running any skill needs a real agent turn: what the skill does depends on the model, so the free local fake agent (SKILL.md **Free agent turns**) proves at most that the skill text reaches the agent (a `{{ECHO}}` reply), not its behavior. `/test-remotely` also needs a connected remote machine, GitHub push access through GitButler, and a committed branch, none of which the test instance has; report it unreachable. `/subthread` creates a child thread that must be deleted afterwards.
- `ks-companion` needs macOS 14, Swift 6.2, Accessibility and microphone permissions, and an ElevenLabs key. It is unreachable from this Linux harness and the headless browser; report it with that prerequisite.

- **Listed.** Run `"$TB" skill list --project <ks-project-id> --json | jq -c '[.skills[] | select(.pluginId == "kitchen-sink") | .name]'`. It prints `["project-scripts","subthread","test-remotely"]`, each with a `filePath` under the instance's `src/plugins/kitchen-sink/skills/`. Pass `--project` explicitly.
- **Slash menu.** Open the fixture thread with `agent-browser --session "$RUN" open "$URL/projects/<ks-project-id>/threads/<ks-thread-id>"`, focus the composer with `agent-browser --session "$RUN" focus '[contenteditable="true"]'`, and run `agent-browser --session "$RUN" keyboard type "/project-scr"` and `agent-browser --session "$RUN" wait --text "Skills" --timeout 5000`. A `Skills` group appears above the composer; `agent-browser --session "$RUN" snapshot -c | grep -A2 '"Skills"'` shows `button "project-scripts Generate and save repository commands as BB project scripts in the thread-details card. …"`. The items are buttons, not `option`s, so `snapshot -i` filtered for options finds nothing. Clear the draft with `press Escape`, refocus the composer, `press Control+a`, and `press Backspace`, then repeat with `/subthr` (`button "subthread Do the requested work in a linked BB subthread. Use when the user invokes /subthread."`) and `/test-rem` (`button "test-remotely Test the current work on a remote BB machine and return reviewed screenshots or a recorded demo. …"`). Confirm the draft is empty afterwards with `agent-browser --session "$RUN" eval 'document.querySelector("[contenteditable=true]").innerText.trim()'`, which returns `""`; drafts persist across reloads.
- **`/project-scripts` (costs a turn).** On a fixture repository with a `package.json` that defines a `dev` script, send `/project-scripts`. When the turn ends, the `projectScripts` RPC read in [thread details](kitchen-sink-thread-details.md) lists the saved scripts, and the card's row reads `Run <first script>`. <!-- unverified: paid agent turn -->
- **`/subthread` (costs two turns).** Send `/subthread reply with OK` in the fixture thread. A child thread appears under it; confirm with `"$TB" thread list --project <ks-project-id> --json | jq -c '.[] | select(.parentThreadId == "<ks-thread-id>") | {id, title}'`. <!-- unverified: paid agent turns -->
- **Proof.** Save the skill list output and a screenshot of each slash suggestion to `$EV`.
- **Cleanup.** Clear the composer draft, delete saved scripts as the thread-details file says, and delete the fixture project, which deletes its threads.

## Gotchas

- Shared or global skills with the same names, such as `project-scripts` or `test-remotely` from the global catalog, may also be listed. Filter by `pluginId == "kitchen-sink"` before counting; on the test instance on 2026-11-24 each name appeared only once.
- The composer's `/` suggestions are buttons under a `Skills` group, not listbox options. Read them with a full `snapshot -c`, not `snapshot -i` filtered for `option`.
- `/subthread` is user-only; asking the agent to "use a subthread" may not load it.
- Typing in the composer without sending is free; pressing Enter on a slash suggestion may insert it rather than send it. Do not press Enter twice.
- The companion keeps its preferences in `~/Library/Application Support/ClickyBB/` and its key in Keychain. Never point a test companion at the live server.
