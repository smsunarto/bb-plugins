# Source Control

Source Control shows each thread's branch and pull request as one Change: checkout state read on the thread's own host with git or GitButler, and pull request state read from GitHub with a signed-in `gh`. It adds a **Source Control** tab beside the thread, a status button in the thread header, a one-line strip above the composer, a full-page review at **Source Control** in the navigation, a **Review** side-panel tab per Change, Change and Landed cards inside messages, a `.patch`/`.diff` **Diff view**, branch writes (commit, push, pull, land, rename, delete), pull request writes (draft toggle, close, merge, Create PR, fix checks), and agent tools plus a `bb review playbook` command.

## Sub-features

Local checkout (a disposable git repo with a bare local remote drives these):

- `sc-tab` opens the **Source Control** thread tab: heading `Workspace`, the repo name, and a `This thread` section with the branch, commit count, `Local` chip and notes.
- `sc-header-button` shows the Change's status (for example `Local, not pushed`) as a thread header button that toggles the tab. Its label reads `View in Source Control` when the checkout has no status, and the button is absent while the checkout is detached.
- `sc-header-icon` adds a git-branch icon to that header button.
- `sc-strip` shows the Change in one line above the composer, such as `Local branch · verify/feature · 2 uncommitted`.
- `sc-uncommitted` lists `Uncommitted changes` with a count, and opens a file's diff in place.
- `sc-commit` commits every listed uncommitted file through the `Commit uncommitted changes` form.
- `sc-branch-card` shows a `Branch <name>` card for each branch in each `Stack · N branch(es)`, with its status pill (`Unpushed`, `Pushed`, `Ahead`, `Behind`, `Diverged`, `Integrated`, `Conflicted`, `Empty`) and its commit rows.
- `sc-commit-row` expands a commit to list its changed files and diffs, and offers `Open in Review` for a file.
- `sc-push` pushes a branch (`Push <name>`, or `Force push <name>` after a rewrite). It asks first when the push would delete upstream commits.
- `sc-pull` shows `<target> has N new commit(s)` in the header. The header `Pull` button rebases onto the target and asks `Pull anyway` when the branch has diverged from it.
- `sc-land` lands a branch on the target without a pull request (`Land` or `Squash and land`, with `Squashed commit message`).
- `sc-rename` renames a branch through `New name for <name>`.
- `sc-delete` deletes a branch after a confirmation that says what is lost.
- `sc-moved-confirm` replaces an open confirmation with `Review updated branch` when the branch moves under it, and shows `The checkout changed since you looked.` when the server refuses a stale write.
- `sc-base-card` shows the `Common base` card, which folds out to `Before the common base`.
- `sc-tab-states` covers the tab's loading, `none`, `Couldn't read this checkout`, and stale states (`… This is what bb last read.`, `Try again`).
- `sc-nav-page` opens the review page at `/plugins/source-control/source-control`, with the `Changes` list in the sidebar, the `Show` filter (`All`, `Mine`, `Asked`), the account picker, and the source footer (`Still reading …`, `Stop`, `Retry`).
- `sc-review-page` shows a Change at `/plugins/source-control/source-control/c/<key>/<tab>`. It has a header, `Review` tabs (`Overview`, `Files`, `Commits`, `Conversation`), a ship path, and the `Stack, checks and review` rail.
- `sc-review-tab` shows one Change's review as a thread side-panel tab titled `Review · <branch>`, or `#N · Review` when opened from a pull request link. Opened with no Change (the **Open new tab** picker's `Review`), it shows `Open Source Control`.
- `sc-files-viewed` marks files `Viewed <path>` and counts them as `N of M viewed`.
- `sc-line-comment` saves a draft comment from the gutter `Comment on this line` button (`Leave a comment…`, `Add comment`).
- `sc-guide` shows the Overview reading guide: `Read in this order`, `Summary`, guide status lines, and `Regenerate guide`.
- `sc-phone` shows the phone list and the compact review header (`Back to changes`) when the page is narrower than 640px.
- `sc-diff-view` opens `.patch`/`.diff` files in the `Diff view` file opener, with `Open as text`/`Show diff` and `Refresh file`.
- `sc-settings` covers `Machine for new worktrees`, `Guide provider`, `Guide model` and `Review instructions` at `/settings/plugins/source-control`.
- `sc-cli-playbook` covers `bb review playbook` (`--name`, `--json`, `--offset`, `--limit`, `--machine`, `--directory`).
- `sc-directive-invalid` renders malformed `::source-control…`, `::source-control-landed…`, `::code-review…` directives as a short note or as their source in `code`.

Needs a message with a directive or link. The free local agent under Preconditions writes one with no paid turn:

- `sc-card-thread` turns `::source-control` into this thread's Change card, with `Open review` and `Ship it`.
- `sc-card-keyed` covers `::source-control{key="…" revision="…"}` (the share tool's output), with the moved and stale notes.
- `sc-card-checkout` covers `::source-control{path="/abs" branch="name"}` for another checkout.
- `sc-card-group` covers `::source-control{changes="…"}`, one card for 2 to 25 Changes with `Ship all` and `Merge all`.
- `sc-landed-card` covers `::source-control-landed{prs="…" commits="…"}` and its legacy name `::code-review-landed`: `Landed work`, the per-item state, `Retry`, and `Settle thread`.
- `sc-legacy-card` covers `::code-review{pr=…|branch=…|targets=…}` cards from the retired Code Review plugin.
- `sc-pr-links` opens a plain click on a GitHub pull request link in a message as a Review tab (`Opening its review…`), which falls back to `Open #N on GitHub` and `Try again`.

Needs a paid agent turn:

- `sc-ship-it` covers `Ship it` on a card or the strip (`Asked the agent to ship it.`).
- `sc-review-run` covers `Review with bb`, `Reviewing…`, `Run again` and `Open` in the rail, and the `Findings` card in the tab (`Select all`, `Fix N selected`, `Show all N`).
- `sc-ask` covers the `Ask agent` panel (`Ask anything.`, `Send question`, `Open as full thread`, `Close`).
- `sc-send-tray` covers `Review goes to` `Agent`/`GitHub`, the `Send tray` and its thread picker, `Send N to agent`, the batch pill, `Stop agent`, and agent replies under comments.
- `sc-ask-to-fix` covers `Ask agent to fix` when `git` or `but` is missing on the checkout host.
- `sc-tool-share-change` covers the `source_control_share_change` tool (`Sharing the Change`/`Shared the Change`) and the directive snippets in thread instructions.
- `sc-tool-reply` covers `source_control_reply`, available in every thread.
- `sc-tool-report-findings` covers `source_control_report_findings`, offered only to `Review with bb` threads.
- `sc-tool-write-guide` covers `source_control_write_guide`, offered only to hidden guide runs.
- `sc-tool-watch-pr` covers `source_control_watch_pr` (`Updating pull request watch`), `source_control_share_landed`, and the `babysit-pr` skill. These are offered to author threads only while the `code-review` plugin is not running.

Needs GitHub: a GitHub remote plus a signed-in `gh` on the server or the checkout host, and usually an open pull request:

- `sc-pr-chip` covers the tab's pull request chip (`Open`, `Draft`, `Merged`, `Closed`, `No PR`) with `Mark ready for review`/`Convert to draft` and `Close pull request`, plus `Open #N on GitHub`.
- `sc-create-pr` covers `Create PR for <branch>` when GitHub has no pull request for a pushed branch. It starts a child thread, a paid turn.
- `sc-merge` covers `Merge` in the tab, the page header, the card (`Merge it`) and the group (`Merge all`), with the `Merge pull request` dialog.
- `sc-checks` covers check chips (`N Failing`, `N Running`, `Passed`), the rail's `Checks`, and the `Fix failing checks` dialog (a paid turn).
- `sc-conversation` covers the `Conversation` timeline and the `Description` (`Show full description`). Without a pull request it reads `This change has no pull request yet.…`.
- `sc-inbox` covers the nav's GitHub rows, the account picker, `Mine`/`Asked`, and the nav badge `N review(s) requested`.
- `sc-other-machines` covers the `Other machines` card (`On <host>`, `Open checkout <path>`, `New chat in <path>`). It needs a GitHub remote and a second machine.
- `sc-pr-watch` covers the `Watched pull requests` banner above the composer, with `Unwatch <owner/repo#N>`, `Open <key> on GitHub` and per-check `Details for <name>`.
- `sc-slopcop` covers the SlopCop group in the rail's review section (`Run again`). It needs the `slopcop` plugin and a pull request.
- `sc-info-pr-row` covers the Info tab's `Pull request` row for a GitButler thread.

GitButler workspace (needs `but` on the checkout host):

- `sc-gitbutler` covers several stacks, `Assigned changes`, the `Onto` branch select in the commit form, the folded `Operation history` card (`Copy snapshot id …`, and `Ask agent to restore snapshot …`, which is a paid turn), and the Info tab's `GitButler branches` section.
- `sc-read-as-git` covers `Read as plain git` and `Read as GitButler`, offered only when the host reports `but` missing for a GitButler workspace.

Other:

- `sc-import` covers `bb source-control import [--json]`, registered instead of `bb review` while `code-review` runs.
- `sc-host-offline` covers the offline banner and `Push, pull, and land need the host.…`. It needs a checkout host that goes offline.
- `sc-pr-watch-wake` messages a thread that watches a pull request when checks fail or finish, comments arrive, or it merges; news that arrives while the thread works is held until it is idle. Needs a real pull request on GitHub. <!-- unverified: added from a source audit, not driven -->
- `sc-landed-title` puts 🚀 before the thread title once all listed pull requests and commits have landed. Needs GitHub. <!-- unverified: added from a source audit, not driven -->
- `sc-rpc-genui` serves `checkoutStatus`, `checkoutFiles`, `checkoutPatches`, and `statusForThread` to GenUI's Changes, Commits, Environments, and Threads components; see [GenUI](genui.md). <!-- unverified: added from a source audit, not driven -->
- `sc-pr-images` serves pull request description images through `/api/v1/plugins/source-control/http/pr-image`. Needs GitHub. <!-- unverified: added from a source audit, not driven -->
- `sc-phone-swipe` lets a wide diff scroll sideways on a phone instead of opening bb's sidebar. Needs touch input. <!-- unverified: added from a source audit, not driven -->

## How to get to it (user POV)

- Open a thread whose project has a git checkout and whose environment exists. Choose the status button in the thread header (`Local, not pushed`, `Pushed`, …) to show or hide the right panel on the **Source Control** tab. The tab is also the fixed `Source Control` button (`Show source control panel`) in the right panel's toolbar; it is not in the **Open new tab** picker.
- Read the strip above the composer. Message cards appear wherever an agent reply holds a directive.
- Open **Source Control** in bb's nav rail, second under **New thread**, or go to `/plugins/source-control/source-control`. Choose a row in the `Changes` list.
- From the tab, expand a commit, open a file, and choose `Open in Review`. From a card, choose `Open review`. Either opens the **Review · <branch>** side-panel tab. The **Open new tab** picker's `Review` button opens an empty Review tab.
- Open a `.patch` or `.diff` file in a thread to get **Diff view**.
- Open **Settings → Plugins → Source Control** at `/settings/plugins/source-control`.
- From a shell, run `bb review playbook`, or `bb source-control import` while code-review runs.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin source-control`.
- Confirm which CLI command is registered. The `code-review` plugin is not in this repository. If live has it, Source Control registers `bb source-control import` and stands down its watch and landed tools. `"$TB" plugin list --json | jq '.plugins[] | select(.id=="code-review") | {enabled, status}'` prints nothing when it is not installed, and then `bb review playbook` is registered.
- **Record settings first.** `"$TB" plugin config source-control --json | jq .values > "$EV/sc-settings-before.json"` and `"$TB" plugin config provider-acp --json | jq -r .values.customAgents > "$EV/acp-before.txt"`.
- **Free local agent.** The tab, header button, and strip render only for a thread with an environment, and a `--send-at` thread has none until its first turn (`environmentId` stays `null`, `terminal create --thread` fails `thread_environment_unavailable`). Register the fake agent as SKILL.md **Free agent turns** describes; its provider id is `acp-verify-fake`. Spawn only with `--provider acp-verify-fake`; any other provider is a paid turn.

- **Guide safety net.** This run set `"$TB" plugin config source-control set guideProvider acp-verify-fake` while it drove the navigation list, so an accidental row choice would not start a paid guide run, and restored it with `unset guideProvider`. No guide run started, so what a guide run on the fake agent shows is unknown. This is a guard against mistakes, not a way to verify the review page without the parent's approval. <!-- unverified: guide run on the fake agent -->
- **Fixture repository.** Create a bare local remote, a clone with a feature branch carrying two commits, and two uncommitted files. Land needs git 2.38 or newer.

  ```bash
  R="$FX/verify-sc"; O="$FX/verify-sc-origin.git"
  git init -q --bare -b main "$O" && git clone -q "$O" "$R"
  git -C "$R" config user.name Verify && git -C "$R" config user.email verify@example.invalid
  printf 'hello\n' > "$R/README.md" && git -C "$R" add README.md && git -C "$R" commit -qm "Initial commit"
  git -C "$R" push -q origin HEAD:main && git -C "$R" remote set-head origin -a
  git -C "$R" switch -qc verify/feature
  printf 'one\n' > "$R/feature.txt" && git -C "$R" add feature.txt && git -C "$R" commit -qm "Add feature file"
  printf 'two\n' >> "$R/feature.txt" && git -C "$R" commit -qam "Extend feature file"
  printf 'draft\n' > "$R/notes.txt" && printf 'again\n' >> "$R/README.md"
  git -C "$R" symbolic-ref refs/remotes/origin/HEAD   # prints refs/remotes/origin/main
  ```

- **Fixture project and thread.** Attach the thread to the checkout itself and run one free turn, which creates the environment:

  ```bash
  "$TB" project create --name verify-sc --root "$R" --json | jq -r .id
  "$TB" thread spawn --project <pid> --title "SC fixture" --prompt hello --provider acp-verify-fake \
    --permission-mode full --environment "$R" --json | jq -r .id
  "$TB" thread wait <tid> --timeout 60          # reached status idle
  "$TB" thread show <tid> --json | jq .thread.environmentId   # env_…, not null
  ```

- **RPC second view.** `printf '{"keys":["<tid>"]}' > "$FX/thread.json"`, then `"$TB" plugin rpc call source-control changeForThread --input-file "$FX/thread.json" --json | jq '.["<tid>"] | {state, branch, key}'`. It prints `state: "checkout"`, the branch, and a key `local:<host-id>:<path>/.git:<branch>`. `.local.read.value` holds `uncommitted` and `stacks[].branches[]` with `status` (`unpushed`, …). The keyed reads `statusForThread`, `changeDetail`, `reviewForChange` and `guideForChange` take the same `{"keys":[…]}` input, with ChangeKeys for the last three.

- **Open the thread (`sc-tab`, `sc-header-button`, `sc-header-icon`).**
  - Run `agent-browser --session "$RUN" open "$URL/projects/<pid>/threads/<tid>"`, then `agent-browser --session "$RUN" wait --text "SC fixture" --timeout 15000`.
  - The header button's accessible name is `Local, not pushed`. Run `agent-browser --session "$RUN" find role button click --name "Local, not pushed"`, then `agent-browser --session "$RUN" wait '[data-testid="sc-changes"]' --timeout 15000`.
  - The tab shows heading `Workspace` beside `verify-sc` and a header `Pull` button, then region `This thread` with a `Local` chip, `verify/feature`, `verify/feature · 2 commits · 2 uncommitted`, a second `Local` chip in list `Needs attention`, and the note `No GitHub remote; this Change is local to its checkout. Not pushed.`
  - `agent-browser --session "$RUN" eval 'document.querySelectorAll("[data-thread-header-workflow-actions] [data-sc-header-icon]").length'` returns `1`.
  - Choosing the header button again hides the right panel: the toolbar button changes from `Hide right panel (Ctrl + \)` to `Show right panel (Ctrl + \)`. The tab's DOM stays mounted, so check the toolbar button, not `[data-testid="sc-changes"]`.
- **Strip (`sc-strip`).** `agent-browser --session "$RUN" get text '[data-testid="sc-strip"]'` returns `Local branch`, `verify/feature`, `2 uncommitted`. After a push it reads `Pushed` and the branch; while the checkout is detached the strip is absent.
- **Uncommitted files (`sc-uncommitted`).** Region `Uncommitted changes` has button `Uncommitted changes 2` and list `Changed files` with `README.md Modified` and `notes.txt Added`. Run `agent-browser --session "$RUN" find role button click --name "notes.txt Added"`: the row reports `expanded=true` and its diff (`1 draft`) appears under it.
- **Commit (`sc-commit`).**
  - Run `agent-browser --session "$RUN" find role button click --name "Commit 2 files"`. Form `Commit uncommitted changes` opens with textbox `Commit message`, the line `Commits the 2 files listed onto verify/feature.`, `Cancel`, and a disabled `Commit`.
  - Run `agent-browser --session "$RUN" find role textbox fill "Verify commit" --name "Commit message"`, then `agent-browser --session "$RUN" find role button click --name "Commit" --exact`. Without `--exact` the name also matches other buttons.
  - `wait --text "No uncommitted changes"` passes. `git -C "$R" log -1 --format=%s` prints `Verify commit`, and `git -C "$R" status --porcelain` prints nothing.
- **Commit rows (`sc-commit-row`).** A commit row's name carries its age, such as `Extend feature file 2m`; `find role button click --name "Extend feature file"` matches it by substring. The row reports `expanded=true` and lists `feature.txt Modified`. Choose that file: an `Open in Review` button and its diff appear. Do not choose `Open in Review` unless a guide run is acceptable; see Gotchas.
- **Push (`sc-push`).** Run `agent-browser --session "$RUN" find role button click --name "Push verify/feature"` and `wait --text "Pushed"`. The pill reads `Pushed`, the `Push` button leaves the card, and the header button's name becomes `Pushed`. `git -C "$O" log --oneline verify/feature` lists `Verify commit`, `Extend feature file`, `Add feature file`, `Initial commit`.
- **Pull (`sc-pull`).**
  - Advance the target from a second clone, then fetch:

    ```bash
    git clone -q "$O" "$FX/other" && git -C "$FX/other" -c user.name=V -c user.email=v@example.invalid commit -q --allow-empty -m "Upstream change" && git -C "$FX/other" push -q origin HEAD:main && git -C "$R" fetch -q
    ```

  - Run `agent-browser --session "$RUN" wait --text "has 1 new commit" --timeout 30000`. The header reads `main has 1 new commit`, and its button becomes `Pull 1 new commit`. Choose it.
  - The branch has its own commits, so the header asks `Pulling may leave conflicts in verify/feature. Resolve them before pushing.` with `Cancel` and `Pull anyway`. Choose `Pull anyway`.
  - `git -C "$R" log --oneline -5` shows the branch's commits above `Upstream change`. The card turns `Diverged` with `Force push`, the section `Upstream, not in this branch 3` (the pre-rebase copies), and the note ends `4 to push · 3 to pull`.
- **Force push and its question (`sc-push`).**
  - Choosing `Force push verify/feature` right after the pull pushes without asking, because the upstream commits are patch-equivalent copies of the rebased ones.
  - To see the question, put a commit with content on the remote branch only, and one on the local branch:

    ```bash
    git -C "$FX/other" fetch -q && git -C "$FX/other" switch -qC verify/feature origin/verify/feature && printf 'remote\n' > "$FX/other/remote.txt" && git -C "$FX/other" add remote.txt && git -C "$FX/other" -c user.name=V -c user.email=v@example.invalid commit -qm "Remote only file" && git -C "$FX/other" push -q origin verify/feature && git -C "$R" fetch -q
    printf 'local\n' > "$R/local.txt" && git -C "$R" add local.txt && git -C "$R" commit -qm "Local only file"
    ```

  - Wait for `Diverged`, then choose `Force push verify/feature`. The card asks `Force push verify/feature? This deletes the upstream commit shown in this stack from the remote.` with `Cancel` and `Force push`, and lists `Remote only file` under `Upstream, not in this branch 1`. Choose `Force push` (`--exact`). `git -C "$O" log --oneline -1 verify/feature` prints `Local only file`.
  - A branch whose remote is ahead with no local commits shows the `Behind` pill.
- **Stale confirmation (`sc-moved-confirm`).**
  - Run `agent-browser --session "$RUN" find role button click --name "Rename verify/feature"`. The card asks `Rename verify/feature?`, and textbox `New name for verify/feature` takes focus, prefilled with the current name; `Rename` is disabled.
  - In a shell, run `git -C "$R" commit -q --allow-empty -m "Moved under the question"`. Within a few seconds the card reads `This branch changed while the confirmation was open. Review the updated branch before continuing.` with `Cancel` and `Review updated branch`. Choose `Review updated branch` to return to the rename question.
- **Rename (`sc-rename`).** Click the textbox, `press Control+a`, `keyboard type "verify/renamed"`, and `press Enter`. Card `Branch verify/renamed` appears (`wait 'article[aria-label="Branch verify/renamed"]'`), and `git -C "$R" branch --show-current` prints `verify/renamed`. An unchanged name or a name with a space leaves `Rename` disabled; hover its wrapper to read the reason as a tooltip, `Type a new name.` or `A branch name has no spaces and does not start with - or refs/.`
- **Common base (`sc-base-card`).** Choose `agent-browser --session "$RUN" find role button click --name "Common base"`. Its name reads `Common base <subject> · <sha> on origin/main · fetched <age>`. Expanded, it shows `Before the common base` with the older history rows.
- **Delete (`sc-delete`).** Make a branch to delete: `git -C "$R" switch -qc verify/delete-me && git -C "$R" commit -q --allow-empty -m "Delete me"`. Choose `Delete verify/delete-me`. The card asks `Delete verify/delete-me? Its N commits were never pushed, so only git's reflog keeps them afterwards. The checkout is left detached at its last commit.`, with `Cancel` and `Delete`. N counts every commit since the target, including ones other branches hold. Choose `Delete` (`--exact`). `git -C "$R" branch --list verify/delete-me` prints nothing, the tab reads `This thread's checkout has no branch checked out.`, and the header button and strip disappear.
- **Land (`sc-land`).** Do this near the end: it deletes the branch and leaves the checkout detached.
  - `git -C "$R" switch -q verify/renamed`, wait for its card, then choose `Land verify/renamed`.
  - With several commits the card asks `Squash verify/renamed's N commits into one and land it on the target branch? This pushes it to the remote without a PR and can't easily be undone. An existing PR may remain open after these commits are rewritten.` Textbox `Squashed commit message` is prefilled with the commit subjects. Replace it (click, `Control+a`, `keyboard type "Verify squash land"`) and choose `Squash and land`.
  - `git -C "$O" log -1 --format=%s main` prints `Verify squash land`, `git -C "$R" branch` no longer lists `verify/renamed`, and the tab reads `This thread's checkout has no branch checked out.`
  - A one-commit branch instead asks `Land <branch> on the target branch? This pushes it to the remote without a PR and can't easily be undone.` with a `Land` button and no message field.
- **Tab states (`sc-tab-states`).** The detached text is above. The loading skeleton (`Reading this checkout`, `aria-busy`) did not show on a reload with a warm cache; capture it only on a cold first open. The stale banner (`… This is what bb last read.`, `Try again`) and `Couldn't read this checkout` need a failing host or a missing tool, so they stay mapped only. <!-- unverified -->
- **Navigation page (`sc-nav-page`).** This list alone starts no guide run; choosing a row does.
  - Run `agent-browser --session "$RUN" open "$URL/plugins/source-control/source-control"`, then `agent-browser --session "$RUN" wait --text "Pick a change from the list to review its files and commits." --timeout 15000`.
  - The sidebar is navigation `Changes` (`[data-testid="sc-changes-nav"]`) with heading `Changes`, button `All accounts` (`sc-account-picker`), and radiogroup `Show` with `All N`, `Mine N`, `Asked N` (`sc-filter-all|mine|asked`). The picker opens `menuitemradio` items `All accounts` and one per signed-in GitHub account.
  - With `gh` signed in on the host, the list holds the user's real GitHub pull requests (`Open pull request #N …`) grouped by repository, and the footer reads `Still reading GitHub (<account>)` until they load. The `verify-sc` group holds one row named `Local branch <last subject> <age> Needs attention <host>`.
  - bb's nav rail entry is named `Source Control, N reviews requested`.
- **Review page (`sc-review-page`, `sc-files-viewed`, `sc-line-comment`, `sc-guide`).** <!-- unverified: choosing a row opens the review page, which claims a guide run; not driven -->
  - Choose the fixture row by its name, never `[data-testid="sc-nav-row"]`, whose first match is a real GitHub pull request: `agent-browser --session "$RUN" find role button click --name "Local branch"`.
  - The URL contains `/plugins/source-control/source-control/c/` and ends `/overview`. The header shows the branch, `→ main`, the file count and `+N −N`. Tabs `Overview`, `Files`, `Commits` and `Conversation` appear. `Conversation` reads `This change has no pull request yet. Its conversation starts once it has one.` The rail shows `Stack`, `Checks run once the branch has a pull request.` and `No review yet` with `Review with bb`.
  - `find role tab click --name "Files"` changes the URL's last segment to `files`. `find role checkbox click --name "Viewed feature.txt"` makes the progress read `1 of N viewed`, which survives a reload and shows in `guideForChange`.
  - The gutter `Comment on this line` button appears on a hovered line; fill `Comment` (placeholder `Leave a comment…`) and choose `Add comment` or press Ctrl+Enter. A `Pending` draft appears, and `reviewForChange` lists it.
  - Overview shows `bb is writing the guide. Files are in path order until then.`, then `Read in this order` and `Summary`. A failed run shows `bb couldn't write the guide.` with `Try again`. Find the run with `"$TB" thread list --project <pid> --include-hidden --json`.
- **Review side tab (`sc-review-tab`).**
  - Empty: choose `Open new tab` in the right panel toolbar, then `Review`. A tab `Review` opens with `Open Source Control`, and no hidden thread appears in `thread list --include-hidden`.
  - From a commit file's `Open in Review`, a tab `Review · verify/…` opens on `Commits` at that file; opening the same Change again focuses it. <!-- unverified: starts a guide run -->
- **Phone (`sc-phone`).** Run `agent-browser --session "$RUN" set viewport 390 844 3`, then open `$URL/plugins/source-control/source-control` and `wait --text "Changes"`. The page shows a large `Changes` heading, the account picker, the `Show` radios, and the grouped rows, with no review pane. Choosing a row shows the compact header with `Back to changes`. <!-- unverified: row choice starts a guide run --> Restore `set viewport 1920 1080 2`.
- **Diff view (`sc-diff-view`).** Write `git -C "$R" format-patch -1 --stdout HEAD > "$R/.git/verify.patch"`. With the thread open in the browser, run `"$TB" thread open <tid> "$R/.git/verify.patch"`; it prints `Source: workspace`, `Path: .git/verify.patch`, and `Delivered: N`, the count of connected clients. A `verify.patch` tab opens with `[data-testid="sc-patch-file"]`: `1 file +1 −0`, a region per commit with its subject and `sha · author · date`, and a region per file with button `Added one.txt +1 −0`. `Open as text` becomes `Show diff`, which returns, and `Refresh file` re-reads.
- **Settings (`sc-settings`).** Run `agent-browser --session "$RUN" open "$URL/settings/plugins/source-control"` and `wait --text "Machine for new worktrees"`. The textboxes are `Machine for new worktrees`, `Guide provider` and `Guide model`, plus the multiline `Review instructions`. Fill `Guide model` with `verify-model` and press `Tab`; the value saves on blur, and `"$TB" plugin config source-control --json | jq .values.guideModel` prints `"verify-model"`. Restore with `"$TB" plugin config source-control unset guideModel`.
- **CLI (`sc-cli-playbook`).**
  - `"$TB" review playbook` prints `global/blast-radius — …`, `global/correctness`, `global/design`, `global/interface`, `global/performance` and `global/security`, and on stderr `Warning: Project playbooks need a BB thread with a checkout, or --machine <id> --directory <absolute-checkout>.`
  - `"$TB" review playbook --name global/correctness` prints the playbook's Markdown with its frontmatter. `--json` prints `{playbooks, warnings, nextOffset}`, with `nextOffset: null` when nothing remains. `--limit 2` ends with `More playbooks: rerun with --offset 2.`
  - For project playbooks, add `$R/.agents/review/verify.md` with frontmatter `description: Verify playbook`. Get the host id from `"$TB" machine list --json | jq -r '.[0].id'`. `"$TB" review playbook --machine <host-id> --directory "$R"` then lists `project/verify — Verify playbook`, and `--name project/verify` prints it. Remove the file afterwards so the checkout stays clean.
  - `--machine` without `--directory` fails with `Project playbooks require both --machine and --directory.`
- **Directive cards (`sc-card-thread`, `sc-card-checkout`, `sc-landed-card`, `sc-directive-invalid`, `sc-pr-links`).** The free agent writes the reply. Put these lines in `$FX/reply.md`, separated by blank lines, with `$R` expanded, then send a follow-up with `"$TB" thread tell <tid> "show directives"` and `"$TB" thread wait <tid> --timeout 60`:

  ```
  ::source-control
  ::source-control{key="%E0%A4%A"}
  ::source-control{pr="not a pr"}
  ::source-control{path="relative/path"}
  ::source-control{path="<absolute $R>" branch="<current branch>"}
  ::source-control-landed{commits="octo/repo@0123456789abcdef0123456789abcdef01234567"}
  ::source-control-landed{bogus="1"}
  ::code-review{pr="bogus"}
  https://github.com/octo/repo/pull/1
  ```

  - The first line becomes the thread's Change card: `Local branch`, the branch, the last commit subject, `Open review` and `Ship it`. The absolute-path line renders the same card for that checkout. Do not choose `Open review` (guide run) or `Ship it` (messages the agent).
  - The next three render `This link to a change is not one bb can read.`, `This is not a pull request bb can read. Name it as owner/repo#123 or by its GitHub URL.` and `Name the checkout by its absolute path, such as /home/me/git/repo.` These run together as one line of text.
  - The valid landed line renders region `Landed work` with `Source Control`, status `Unavailable`, heading `1 commit`, a link to the commit, the alert `No signed-in GitHub account can see octo/repo.` with `Retry`, and `Settle thread`. Choosing `Settle thread` archives the thread and returns to Home; `"$TB" thread show <tid> --json | jq .thread.archivedAt` prints a timestamp. Restore with `"$TB" thread unarchive <tid>`.
  - The bogus landed and code-review lines render their own source inside `code`, side by side on one line.
  - Scroll the PR link into view and click it. A Review tab `#1 · Review` opens reading `octo/repo#1` and `Opening its review…`, then `No signed-in GitHub account can see octo/repo.` with link `Open #1 on GitHub` and `Try again`. This tab never reaches a Change, so it starts no guide run.
  - `sc-card-keyed` and `sc-card-group` need a key from `source_control_share_change` or several Changes; they are not driven. <!-- unverified -->

- **Agent tools (`sc-tool-*`).** These need a real model that calls the tool, which is a paid turn. The fake agent cannot call tools. <!-- unverified --> `source_control_report_findings` appears only in `Review with bb` threads, and `source_control_write_guide` only in hidden guide runs. Their proof is the findings in the rail's `Review` section and the guide on Overview.
- **Proof.** Capture `"$EV/sc-<state>.png"` and `agent-browser --session "$RUN" snapshot -c -s '[data-testid="sc-changes"]' > "$EV/sc-<state>.snapshot.txt"` before and after each write, plus the `git` output that confirms it.
- **Cleanup.** Run `"$TB" project delete <pid> --yes`, then `rm -rf "$FX"`. Restore `customAgents` with `"$TB" plugin config provider-acp set customAgents "$(cat "$EV/acp-before.txt")"`, unset `guideProvider` and any other changed key, and confirm `"$TB" provider list --json` no longer lists `acp-verify-fake`.

## Gotchas

- Opening any Change's review claims a hidden guide run once per Change: the review page, the Review side tab with a Change (`Open in Review`, a card's `Open review`), and a phone row. That is an agent turn on `Guide provider`/`Guide model`, or on the project default when both are empty. Point `Guide provider` at the free local agent before any of these, or leave them unverified.
- `[data-testid="sc-nav-row"]` matches every row, and with `gh` signed in the first is a real GitHub pull request. Choosing it starts a guide run on that PR. Pick the fixture row by name.
- A `--send-at` fixture thread has no environment, so the tab, header button, strip, and `bb terminal` stay absent. Run one turn on the free local agent first.
- `Ship it`, `Create PR`, `Review with bb`, `Ask agent`, `Send … to agent`, `Fix … selected`, `Fix failing checks`, `Ask agent to fix` and `Ask agent to restore snapshot` all start or message an agent. None was driven. Several start a new thread on the project's default provider rather than the fixture thread's, so treat every one as a paid turn.
- Land and Delete in a plain git checkout leave it detached, and the tab then shows only a reason. Land also deletes the landed branch. Run them last, or recreate a branch afterwards.
- Force push asks only when it would delete a remote commit whose patch is not already on the branch. Empty commits are patch-equivalent to each other, so test the question with commits that change files.
- Pull, Land and Commit refuse a dirty or busy checkout in different ways: Pull and Land need a clean worktree, so commit first.
- `refs/remotes/origin/HEAD` must exist. Without it there is no target: no `Pull`, no `Land`, no `Common base`.
- A non-GitHub remote means no forge read for the fixture. The chip reads `Local`, and no pull request, checks, Create PR, merge, or Other machines appear. These are not product gaps. The navigation inbox still lists the host's real GitHub pull requests when `gh` is signed in.
- Buttons inside a confirmation share words with the card's own buttons (`Commit`, `Force push`, `Delete`, `Land`). Use `--exact` or a ref from a scoped snapshot.
- Hover-only UI: the gutter `Comment on this line` button needs a hovered line. Headless Chrome reports `(hover: none)`, so say which path you drove.
- The header button's name changes with the Change's state (`Local, not pushed`, `Pushed`, `#12 · Ready to merge`, …) and disappears while detached. Read it from a snapshot before choosing it.
- `Read as plain git` appears only when the host reports `but` missing for a GitButler workspace. `but` is installed here, so that path is unreachable without changing the host.
- The `::code-review` and `::code-review-landed` directive ids clash with the Code Review plugin. bb fails both registrations when it is enabled.
- The thread tab is a resizable `thread-panel`. Check it at narrow and wide widths per AGENTS.md **Resizable thread side-panel tabs**. <!-- unverified: not resized in this run -->
