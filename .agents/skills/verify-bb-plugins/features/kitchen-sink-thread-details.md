# Kitchen Sink: thread details and project scripts

Kitchen Sink adds two rows to bb's thread context card, the card at a thread pane's upper-right: a machine row naming the thread's host, with a menu to copy the checkout path or open a terminal there, and a scripts row that runs, adds, edits, and deletes shell commands saved for every thread in the project. Each script runs in a new terminal at the thread's checkout. The card exists only while bb's **Thread context card** experiment is on.

## Sub-features

- `ks-card-rows` shows the machine row (host name, checkout path as its tooltip) and, for a thread with a checkout, the scripts row in the thread context card. A thread with no environment yet, such as a scheduled one, shows the machine row alone with no menu.
- `ks-checkout-menu` opens **Checkout actions** with a `Checkout` or `Worktree` label, **Copy path**, and **Open terminal**.
- `ks-copy-path` copies the checkout path and toasts `Copied the path`.
- `ks-open-terminal` opens a thread-scoped terminal in the thread's terminal panel.
- `ks-script-add` adds a script from **Add project script**; the row becomes `Run <name>`.
- `ks-script-run` runs the row's script in a terminal titled with the script's name.
- `ks-script-menu` lists every script under **Project scripts** (`Run` group, then `Edit <name>` items, then **Add project script**); running one from the menu makes it the row's default for that thread.
- `ks-script-edit` renames or changes a script from **Edit <name>**.
- `ks-script-delete` deletes a script from its edit dialog; with none left, the row returns to **Add project script**.
- `ks-script-limit` refuses a 21st script with `A project keeps at most 20 scripts.`
- `ks-scripts-failed` shows `Scripts unavailable` with a `Retry` trailing label when the list cannot load.
- `ks-scripts-shared` shares one script list across every thread and client of a project.
- `ks-scripts-rpc` lists and edits the same list from the CLI through the discoverable `projectScripts` and `saveProjectScript` RPC methods, which the `/project-scripts` skill drives.

## How to get to it (user POV)

- Turn on bb's `threadContextCard` experiment (`bb settings experiment threadContextCard true`). Live and the test instance both had it on on bb 0.50.1.
- Open any project thread. In a wide pane the card sits pinned at the pane's upper right; the header button **Unpin thread context** / **Pin thread context** hides or shows it (the choice is the synced UI preference `threadContextCard.pinned`). In a narrow pane (a 1100px viewport is enough) the header button **Thread context** opens it as a popover.
- In the card, the machine row's chevron **Checkout actions** opens the checkout menu, and the scripts row's chevron **Project scripts** opens the scripts menu. The chevrons show on hover or focus and always on touch.
- Choose the scripts row label itself (`Run <name>` or `Add project script`) to run the default script or add the first one.
- From a thread, `/project-scripts` asks the agent to inspect the repository and save scripts through the RPC.
- Phones (compact viewport with a coarse pointer) get no card and so no scripts UI. <!-- unverified -->

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin kitchen-sink`.
- The experiment is on. Record its mirrored value; set it only if it is off:

  ```bash
  "$TB" settings show --json | jq .experiments.threadContextCard   # record for cleanup
  "$TB" settings experiment threadContextCard true                 # only when it printed false
  ```

- One fixture project with an idle thread exists. Record the printed ids:

  ```bash
  FX="$BB_THREAD_STORAGE/verify/$RUN-fixtures"; mkdir -p "$FX"
  git init -q "$FX/verify-ks" && git -C "$FX/verify-ks" commit -q --allow-empty -m init
  "$TB" project create --name verify-ks --root "$FX/verify-ks" --json | jq -r '.project.id // .id'
  AT=$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)   # macOS: date -u -v+7d +%Y-%m-%dT%H:%M:%SZ
  "$TB" thread spawn --project <ks-project-id> --title "KS fixture" --prompt hello --send-at "$AT" --json | jq -r '.thread.id // .id'
  "$TB" thread show <ks-thread-id> --json | jq .thread.environmentId
  ```

- **Checkout thread (free fake turn).** The checkout menu, the terminal, and the whole scripts row render only for a thread with an environment. A `--send-at` thread has `environmentId: null` even with `--environment`, because bb creates the environment at the first dispatch, and an idle `thread fork` of it fails with `Source thread has no environment.` Register the local fake agent as SKILL.md **Free agent turns** describes (provider `acp-verify-fake`), then spawn one turn on it:

  ```bash
  "$TB" thread spawn --project <ks-project-id> --provider acp-verify-fake --environment "$FX/verify-ks" --title "KS env" --prompt hello --json | jq -r '.thread.id // .id'
  "$TB" thread wait <ks-env-thread-id>
  "$TB" thread show <ks-env-thread-id> --json | jq -c '.thread | {environmentId, status}'   # env_…, idle
  ```

  Use `<ks-env-thread-id>` for every step from **Checkout menu** on. The scheduled `<ks-thread-id>` still serves the machine-row-only check. Never spawn a turn on any other provider.

- **Open the card.** Run `agent-browser --session "$RUN" open "$URL/projects/<ks-project-id>/threads/<ks-thread-id>"` and `agent-browser --session "$RUN" wait --text "<host name>" --timeout 15000` (the host is `"$TB" host list --json`'s name). Confirm the card with `agent-browser --session "$RUN" eval '[...document.querySelectorAll("[data-thread-context-card]")].map(e => [e.hidden, e.innerText])'`, which returns `[[false, "<host name>"]]` for a scheduled thread. The card is `group "Thread context"`.
- **Pin and unpin.** On a 1920px viewport run `agent-browser --session "$RUN" find role button click --name "Unpin thread context"`: the same probe returns `[[true, …]]` and the header button becomes `Pin thread context`. Choose `Pin thread context` to show it again. Leave it pinned; the preference syncs to every client of the instance.
- **Narrow pane popover.** Run `agent-browser --session "$RUN" set viewport 1100 1080 2`. The header now has `button "Thread context"` and no card is in the DOM. Choose it: the card opens as a popover with the same rows. Press `Escape` and restore `set viewport 1920 1080 2`.
- **Machine row.** Run `agent-browser --session "$RUN" snapshot -c -s '[data-thread-context-card]'`. For a scheduled thread it holds only `StaticText "<host name>"`; for `<ks-env-thread-id>` the interactive snapshot is `button "Checkout actions"` and `button "Add project script"`. Read the row tooltip with `agent-browser --session "$RUN" eval '[...document.querySelectorAll("[data-thread-context-card] [data-thread-context-card-row]")].map(r => [r.textContent, r.title])'`: the title is the checkout path when the thread has one (`["<host>", "<…>/verify-ks"]`, then `["Add project script", ""]`), otherwise the host name.
- **Checkout menu.** Run `agent-browser --session "$RUN" find role button click --name "Checkout actions"`, then snapshot. The menu shows label `Checkout` (or `Worktree`), item `Copy path` with the path as detail, and item `Open terminal`. Press `Escape` to close it.
- **Copy path.** Reopen the menu and run `agent-browser --session "$RUN" find role menuitem click --name "Copy path"`. A `Copied the path` toast appears (headless Chrome allowed the write; `Could not copy to the clipboard.` where a browser refuses). Read it with `agent-browser --session "$RUN" eval '[...document.querySelectorAll("[data-sonner-toast]")].map(t => t.innerText)'`.
- **Open terminal.** Reopen the menu and run `agent-browser --session "$RUN" find role menuitem click --name "Open terminal"`. The right panel opens with a `bash` terminal tab at the checkout. Confirm with `"$TB" terminal list --thread <ks-env-thread-id> --json | jq -c '.sessions[] | {id, title, status}'`, which lists `{"title":"bash","status":"running"}`; close it with `"$TB" terminal close <terminal-id>`. The open right panel narrows the pane, so the card moves into the header's `Thread context` popover: choose `Hide right panel` before the next card step.
- **Add a script.** Run `agent-browser --session "$RUN" find role button click --name "Add project script"` and `agent-browser --session "$RUN" wait --text "Saved for every thread in verify-ks" --timeout 5000`. The dialog title is `Add project script`. The dialog has textboxes `Name` and `Command`, buttons `Cancel`, `Save` (disabled while either is empty), and `Close`. Fill it with `agent-browser --session "$RUN" find label "Name" fill "Verify echo"` and `agent-browser --session "$RUN" find label "Command" fill "echo verify-ks-ok && sleep 120"`, then `agent-browser --session "$RUN" find role button click --name "Save"`. Run `agent-browser --session "$RUN" wait --text "Run Verify echo" --timeout 5000`. The dialog closes, an `Added Verify echo` toast shows, and the row reads `Run Verify echo`.
- **Stored list.** Read it back:

  ```bash
  echo '{"projectId":"<ks-project-id>"}' > "$EV/ks-list.json"
  "$TB" plugin rpc call kitchen-sink projectScripts --input-file "$EV/ks-list.json" --json
  ```

  On a fresh project it prints `{"scripts": []}`; after the add it lists one script named `Verify echo` with its command. Reload the page; the row still reads `Run Verify echo`.

- **Run the default.** Run `agent-browser --session "$RUN" find role button click --name "Run Verify echo"`. A terminal tab titled `Verify echo` opens in the terminal panel. Confirm with `"$TB" terminal list --thread <ks-env-thread-id> --json`, which lists a running session titled `Verify echo`, and `"$TB" terminal output <terminal-id> | grep -c verify-ks-ok`, which prints `1`. Close it, then `Hide right panel`; the panel's open state persists across reloads.
- **Second script and menu default.** Add `Verify two` with command `echo verify-ks-two && sleep 120` through **Project scripts → Add project script**: run `agent-browser --session "$RUN" find role button click --name "Project scripts"`, then `agent-browser --session "$RUN" find role menuitem click --name "Add project script"`, and fill and save as above. Reopen **Project scripts** and snapshot it: the `Run` group lists `Verify echo` and `Verify two`, as menuitems whose names include their command (`Verify echo echo verify-ks-ok && sleep 120`), then `Edit Verify echo`, `Edit Verify two`, and `Add project script`. Choose the `Verify two` run item by its snapshot ref, since a name search for `Verify two` also matches `Edit Verify two`. A `Verify two` terminal opens and the row label becomes `Run Verify two`.
- **Edit.** Open **Project scripts** and choose `Edit Verify two` by ref. The dialog title is `Edit project script`, prefilled with `Verify two` and its command. Change the name to `Verify renamed` and choose **Save**. A `Saved Verify renamed` toast shows, the row reads `Run Verify renamed`, and the `projectScripts` read shows the same id with the new name.
- **Cancel keeps the list.** Open `Edit Verify renamed`, change the command, and choose **Cancel**. The `projectScripts` read is unchanged.
- **Delete.** Open each script's edit dialog and choose **Delete** (a `Deleted <name>` toast). After the last one, run `agent-browser --session "$RUN" wait --text "Add project script" --timeout 5000`; the `projectScripts` read prints `"scripts": []`.
- **Shared across threads.** Spawn a second fake-turn thread with the same `--environment` and add `Shared one` from the first. Switch to the second thread through the sidebar (`scrollintoview` its `a[data-sidebar-thread-id="<id>"]` first, since a row below the fold refuses `click`): its card reads `Run Shared one` at once. A second browser session shows it after a reload. <!-- the second-session half is unverified -->
- **RPC twin.** The same edits work without the UI, and need no checkout:

  ```bash
  "$TB" plugin rpc list kitchen-sink --json | jq -r '.[].method'   # projectScripts, saveProjectScript
  printf '%s' '{"projectId":"<ks-project-id>","edit":{"kind":"upsert","script":{"id":"verify-rpc","name":"Verify rpc","command":"echo rpc && sleep 120"}}}' > "$EV/ks-save.json"
  "$TB" plugin rpc call kitchen-sink saveProjectScript --input-file "$EV/ks-save.json" --json
  ```

  Each call prints the whole list after the edit. An upsert with an existing `id` replaces that script in place. Delete with `{"projectId":"<ks-project-id>","edit":{"kind":"delete","scriptId":"verify-rpc"}}`. On a thread with a checkout, a reload then shows `Run Verify rpc`. <!-- unverified: the RPC-side upsert was checked by read-back only -->

- **Limit.** Upsert 20 scripts with distinct ids through the RPC, then upsert a 21st id. The call exits 1 with `handler_error: HTTP 500: A project keeps at most 20 scripts.`; `projectScripts` still lists 20, and an upsert of an existing id still succeeds at the limit. In the dialog (**Project scripts → Add project script**, any name and command, **Save**) the same refusal shows a `Could not save the script` toast reading `A project keeps at most 20 scripts.`, and the dialog stays open; choose **Cancel**.
- **Failure state.** `Scripts unavailable` needs the list read to fail, which has no disposable trigger. Treat it as unreachable unless the server is made to reject the call, and say so.
- **Proof.** Capture the card before and after each change with `agent-browser --session "$RUN" screenshot "$EV/ks-card-<state>.png"` and `agent-browser --session "$RUN" snapshot -c -s '[data-thread-context-card]' > "$EV/ks-card-<state>.snapshot.txt"`.
- **Cleanup.** Close every terminal this run opened with `"$TB" terminal close <terminal-id>`. Delete every remaining script through `saveProjectScript` and confirm `projectScripts` prints `[]`; deleting the project does not remove its stored scripts. Then run `"$TB" project delete <ks-project-id> --yes`, remove `$FX`, and restore the experiment to its recorded value with `"$TB" settings experiment threadContextCard <recorded>`.

## Gotchas

- The rows are absent with the experiment off, and on a compact coarse-pointer viewport even with it on. An absent row there is not a product gap.
- A scheduled (`--send-at`) thread has no environment, so its card shows only the host name: no chevron, no scripts row. That is the plugin's design, not a gap; the checkout and scripts UI needs a thread that has dispatched once; one fake-agent turn gives it one at no cost.
- Opening a terminal (from **Open terminal** or a script) opens bb's right panel, which narrows the thread pane and moves the card into the `Thread context` popover. The panel stays open across reloads. Choose `Hide right panel` before the next card step.
- Thread rows low in the sidebar refuse `click` (`outside the viewport`). Run `scrollintoview` on the same selector first.
- The card's layout depends on the pane width: a wide pane pins it, a narrow one opens it from the header's `Thread context` button and removes it from the DOM until opened. Probe `[data-thread-context-card]` before choosing a header button.
- `Unpin thread context` writes the synced UI preference `threadContextCard.pinned` (`"$TB" settings ui list --json`), which other clients of the instance share. Pin it again before finishing.
- Row chevrons are invisible until hovered or focused, and headless Chrome has no hover. Click them by accessible name, or focus the row and press `Tab`.
- `find role … --name` matches by substring, and menu item names include their detail line (the command or the path). Pick script run items and `Edit …` items by snapshot ref.
- `wait --text` may not match toasts. Read them with `eval` on `[data-sonner-toast]` (each toast's `innerText`) right after the action, and assert stored changes from the `projectScripts` read.
- A script that exits before its terminal tab opens is closed again and reports `This view has no terminal panel.` Keep test commands alive with `&& sleep 120`, then close them.
- The row's default script (the last one run) is remembered per thread in the page only; a reload returns it to the first script.
- The dialog submits on `Ctrl+Enter` in **Command**; a stray chord saves the draft.
- A refused RPC call prints its error JSON on stdout and exits 1; check the exit status, not only the output.
- Saved scripts stay in Kitchen Sink's storage after `project delete`. Delete them first so the run leaves no records behind.
