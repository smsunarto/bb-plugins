# SlopCop

SlopCop watches GitHub repositories for new issues and pull requests. When one matches a rule, it dispatches a bb agent and then checks the agent's result against GitHub with `gh`. You manage rules from the **SlopCop** page, with its **Rules** and **Activity** tabs, or with `bb slopcop …`. New rules start in shadow mode: the agent runs the full review and SlopCop stores the body, but nothing is posted. A PR review thread stays open until its PR closes, and a finished thread is settled (archived).

## Sub-features

- `slopcop-page` is the `SlopCop` nav page with its `Rules` and `Activity` tabs and their counts. Its header shows `gh: <login>` (or `gh not authenticated`) and a `New rule` button.
- `slopcop-empty` covers the empty states: `No rules yet` with a `Create a rule` button, and the Activity text `No runs yet. Rules dispatch for new issues or matching pull requests.`
- `slopcop-rule-card` is one card per rule: the name link, a repo badge, a `shadow`/`live` chip, the `Enable <name>` switch, and chips for triggers, keywords, conditions, trust, `hidden threads`, and `⚠ untrusted code, full access`. A card for a rule with no agent shows `No agent configured — open and save once before it can dispatch.`
- `slopcop-rule-toggle` enables and disables a rule from its card switch.
- `slopcop-editor` is the `New rule`/`Edit rule` form: `Rule name`, `Repository`, `Review mode`, `Review threads`, the `Run when` trigger toggles, `PR authors`, `Agent settings`, `Review lenses`, `Review instructions`, `Cancel`, and `Save rule`.
- `slopcop-editor-validation` shows the inline `role=alert` errors: `Give the rule a name first`, `Repository must look like owner/repo`, `Select at least one trigger`, `Add at least one comment or description keyword`, `Add a GitHub username after @.`, and `Choose a project, workspace, and model in Agent settings.`
- `slopcop-editor-keywords` shows `Match keywords` once a keyword trigger is selected, and `Who can request a review` once `Comment matches` is selected.
- `slopcop-editor-filters` is the `Filters & author exclusions` collapsible: `Changed paths match (PR only)`, `Base branch (PR only)`, and `Exclude PR authors`.
- `slopcop-editor-trust` is the `PR authors` select. `Anyone` shows a prompt-injection warning. `Anyone` with live mode and a PR trigger adds `Live reviews from any author` to the footer.
- `slopcop-agent-settings` covers `Change agent settings`/`Close agent settings`, the `Project` and `Workspace` selects, the `Model & reasoning` picker, and the `Permissions` picker.
- `slopcop-lenses` is the `Review lenses` section with the `Deep lenses (A, F, G, H, J)` and `Mechanical lenses (B, C, D, E, I, K)` pickers. It shows only while a non-issue trigger is selected.
- `slopcop-editor-delete` is `Delete rule` on an existing rule.
- `slopcop-draft-restore` keeps an unsaved draft while bb remounts the page, until `Save rule` or `Cancel`.
- `slopcop-test-rule` is the `Test this rule` collapsible. It shows `Save your changes before testing this rule.` while the form has edits. Otherwise it shows `Run now`, with a `PR #`/`issue #` field, `Dry run` (shadow) or `Run` (live), a `Target kind` select on rules that take both kinds, and a `This rule would skip …` block with `Run anyway`.
- `slopcop-activity` lists runs. Each row has a status badge, `PR #n`/`issue #n` and its title, the rule name, `shadow`, the trigger, the age, a `thread` button, `N comment(s)` (which expands to comment rows), and a detail line.
- `slopcop-realtime` updates the page when a rule or run changes from the CLI, with no reload.
- `slopcop-cli-rules` covers `bb slopcop rules [list|add|edit|enable|disable|rm]`.
- `slopcop-cli-status` is `bb slopcop status [--json]`.
- `slopcop-cli-runs` covers `bb slopcop runs`, `show [run-id]`, and `verify [run-id]`.
- `slopcop-cli-check` is `bb slopcop check <rule> <number> [--issue]`, which reports `MATCH — …` or `NO MATCH — <reason>`.
- `slopcop-cli-dispatch` is `bb slopcop dispatch <rule> <number> [--issue] [--force]`.
- `slopcop-cli-review` is `bb slopcop review [number] --repo --event --body [--comments] [--commit]`, which submits one GitHub review.
- `slopcop-settings` covers six settings: `Poll interval (seconds)`, `Max concurrent review threads`, `Path to the gh binary`, `Bot gh wrapper`, `Default review thread section`, and `Settle finished review threads`.
- `slopcop-needs-config` marks the plugin as needing configuration when `gh` is not authenticated.
- `slopcop-watcher` is the poller. Its first pass per repo records the open backlog without dispatching. Later passes dispatch on `ready_for_review`, `new_commits`, `new_issue`, `pr_description_matches`, and `comment_matches`, within the concurrency cap and the dedupe policy, and record trust-gate refusals as `skipped`.
- `slopcop-shadow` is a shadow run that finishes as `shadowed`, with the stored body readable through `show`.
- `slopcop-live-verify` is a live run whose GitHub comments are matched by marker: `commented`, `commented_partial`, `commented_unmarked`, `commented_unattributed`, or `no_comment`.
- `slopcop-thread-lifecycle` covers the review thread title `SlopCop (shadow): <rule> — PR #<n>`, the default section, hidden visibility, and settle on finish. A thread archived or deleted before it reports gives `failed`.
- `slopcop-rereview` continues the same thread after a keyword request comment, advancing its PR worktree to the new head.
- `slopcop-source-control-rpc` covers the discoverable `pullRequestReview` and `runPullRequestAgain` methods that Source Control's Review rail reads.
- `slopcop-review-env` is the `Slopcop PR worktree` environment provider (`slopcop-review`).
- `slopcop-skill` is the plugin's `slopcop` agent skill. SlopCop registers no agent tools; agents use the `bb slopcop` CLI.
- `slopcop-awaiting-children` keeps a review run open while its lens subagents finish, when the turn ends with the `slopcop:awaiting-children` marker. Needs a review run with subagents. <!-- unverified: added from a source audit, not driven -->

## How to get to it (user POV)

- Choose **SlopCop** in the sidebar navigation (a `SlopCop` button under GTD Sidebar's `Navigation`), or open `/plugins/slopcop/slopcop` directly.
- On the page, choose the `Rules` or `Activity` tab. Choose `New rule`, or `Create a rule` on an empty list, to make a rule. Choose a rule's name to edit it, and use its `Enable <name>` switch to turn it on or off.
- In the editor, open `Filters & author exclusions`, `Change agent settings`, and, for a saved rule, `Test this rule`.
- Open **Settings → Plugins → SlopCop** (`/settings/plugins/slopcop`) for the six settings, or use `bb plugin config slopcop set <key> <value>`.
- From a terminal or an agent thread: `bb slopcop rules|runs|show|verify|check|dispatch|review|status`, each with `--json`.
- A review thread opens from the Activity row's `thread` link and appears in the sidebar unless the rule hides its threads.
- Source Control's Review rail shows the SlopCop run state for a PR (`data-testid="sc-slopcop-run"`). Source Control's own feature file covers that.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin slopcop`.
- **Settings check.** Run `"$TB" plugin config slopcop --json | jq -c .values` and record the values to restore later. The mirrored values on 0.50.1 were `{"pollSeconds":"60","maxConcurrentReviews":"3","ghPath":"gh","botGhPath":"","defaultThreadSection":"","settleFinishedThreads":true}`; the numbers are stored as strings, and `plugin config slopcop set pollSeconds 60` stores `"60"  (string)` again. `botGhPath` is not mirrored, so the test instance uses the host's own `gh` login, not live's bot identity. If `defaultThreadSection` is non-empty, the test instance probably lacks that section, and every dispatch that reaches a spawn fails with `no thread section named '…'`.
- **Fixture project.** Create one, and record its id:

  ```bash
  FX="$BB_THREAD_STORAGE/verify/$RUN-fixtures"; mkdir -p "$FX"
  git init -q "$FX/verify-sc" && git -C "$FX/verify-sc" commit -q --allow-empty -m init
  "$TB" project create --name verify-sc --root "$FX/verify-sc" --json | jq -r '.project.id // .id'
  ```

- **What each tier needs:**
  - **No GitHub:** the page, rule CRUD from the UI and the CLI, validation, settings, `status`, the empty `runs`/`show`/`verify`, `review` argument errors, and `pullRequestReview` for a PR SlopCop never ran.
  - **`gh` read only:** an authenticated `gh` on the host and a real readable repo. This tier covers `check`, the `Dry run` blocked reason, and a forced run of a rule with no agent, which records a `failed` run and spawns no thread.
  - **Paid agent turn:** a dispatch of a rule with an agent. Shadow mode posts nothing, but the review costs model usage. This tier covers `shadowed`, `show` with a body, settle, and archive-before-report.
  - **GitHub writes:** `--live`, a valid `review`, and the watcher's event triggers need a disposable GitHub repository that the `gh` identity can write, plus paid turns. Without a bot identity, everything posts as the host user's personal login. Do not run these against a real repository without the user's approval.
- **Repo slugs.** Fixture rules for CRUD use a repo that does not resolve, `verify-none/verify-$RUN`, so the watcher's polls fail harmlessly and never dispatch. Use a real repo (`<owner/repo>`, a public repo the `gh` login can read, with an open or closed PR `<n>`) only for `check` and forced runs of a rule with no agent.

### No GitHub

- **Status.** Run `"$TB" slopcop status`. It prints `gh: <login>` (or `gh: NOT AUTHENTICATED`), `watching: (no enabled rules)`, `polling every 60s` (or the mirrored value), `default section: (unsectioned)` or the section name, and `0 rule(s)` on a fresh instance. Run `"$TB" slopcop status --json | jq -c '{ghAvailable, pollSeconds, rules: (.rules|length)}'` for the stored view: `{"ghAvailable":true,"pollSeconds":60,"rules":0}`.
- **Empty page.** Run `agent-browser --session "$RUN" open "$URL/plugins/slopcop/slopcop"` and `agent-browser --session "$RUN" wait --text "New rule" --timeout 15000`. With no rules, the page shows `No rules yet` and a `Create a rule` button. The empty state also reads `A rule watches one repo for pull requests or issues. New rules start in shadow mode — they run but post nothing until you promote them.` The header shows `gh: <login>` or `gh not authenticated`. The tabs' accessible names are `Rules 0` and `Activity 0` (the tablist's own name is lowercase, `rules0activity0`). Run `agent-browser --session "$RUN" find role tab click --name "Activity"` and `agent-browser --session "$RUN" wait --text "No runs yet"`; the text is `No runs yet. Rules dispatch for new issues or matching pull requests.` Runs persist (see Gotchas), so on a reused instance, expect rows instead.
- **CLI create, rule without an agent.** Run `"$TB" slopcop rules add --name verify-noagent --repo "verify-none/verify-$RUN" --label bug`. It prints `Created 'verify-noagent' (rule_…) in shadow mode.` and `Note: no agent configured yet — open the rule in the SlopCop panel and save it once before it can dispatch.`
- **CLI create, rule with an agent.** Run `"$TB" slopcop rules add --name verify-agent --repo "verify-none/verify-$RUN" --project verify-sc --trigger ready_for_review,comment_matches --keyword "@verify" --paths "src/**" --exclude-author "dependabot[bot]" --json | jq '{id, mode, request: (.request != null), dedupe}'`. It prints `mode: "shadow"`, `request: true`, and `dedupe: "once_per_trigger_event"`. A keyword trigger without `--keyword` exits 1 with a zod issue list whose message is `a comment or description trigger needs at least one keyword` (path `commentKeywords`). **CLI-created rules start enabled** (`[enabled · shadow · …]`); disable them at once if the slug is real.
- **List.** Run `"$TB" slopcop rules`. Each line reads `<name>  <repo>  [enabled · shadow · authors with write access (OWNER, MEMBER, COLLABORATOR) · lenses opus high/sonnet high]  rule_…`. The lens part is the stored default.
- **Cards update live.** Without reloading, `agent-browser --session "$RUN" find role tab click --name "Rules"` shows both cards (realtime refresh), and the tab reads `Rules 2`. Run `agent-browser --session "$RUN" snapshot -i -c > "$EV/sc-cards.snapshot.txt"`. Expect switches `Enable verify-noagent` and `Enable verify-agent`. The `verify-agent` card shows the chips `PR ready for review`, `Comment matches`, `@verify`, `paths src/**`, `exclude PR author @dependabot[bot]`, `trusted authors only`, and `shadow`. The `verify-noagent` card shows the default trigger `PR ready for review`, `label bug`, `trusted authors only`, and the warning `No agent configured — open and save once before it can dispatch.`
- **Toggle.** Run `agent-browser --session "$RUN" find role switch click --name "Enable verify-noagent"`. The switch reports `checked=false`. Run `"$TB" slopcop rules --json | jq -r '.[] | select(.name=="verify-noagent") | .enabled'`, which prints `false`. Toggle it back on. Then `"$TB" slopcop rules disable verify-noagent` prints `Disabled 'verify-noagent'.`, the switch flips with no reload, and `rules enable` reverses it.
- **New-rule validation.** Choose `New rule` (`agent-browser --session "$RUN" find role button click --name "New rule"`), wait for the `New rule` heading, then choose `Save rule` with the form empty. An alert reads `Give the rule a name first`. The new form starts with `PR ready for review` pressed (`aria-pressed=true`), `Review mode` `Shadow — review without posting`, `Review threads` `Show in sidebar`, and `PR authors` `Write access only`. Fill `Rule name` with `agent-browser --session "$RUN" find label "Rule name" fill verify-ui` and save again: `Repository must look like owner/repo`. Fill `Repository` with `verify-none/verify-ui` and save: `Choose a project, workspace, and model in Agent settings.` Choose `Comment matches` (`find role button click --name "Comment matches"`) and save: `Add at least one comment or description keyword`. The `Match keywords` and `Who can request a review` fields appear after the toggle. Choose `PR ready for review` and `Comment matches` again to clear all triggers, then save: `Select at least one trigger`. Open `Filters & author exclusions` (textboxes `Changed paths match (PR only)`, `Base branch (PR only)`, `Exclude PR authors`), click `Exclude PR authors`, and `keyboard type "@"`. The input gets `aria-invalid="true"` (the snapshot does not show it; read it with `eval`), and an alert reads `Add a GitHub username after @.`
- **Trust warning.** In the same form, run `find role combobox click --name "PR authors"`. It lists options `Organization members only`, `Write access only`, `Write access + past contributors`, and `Anyone`; choose `find role option click --name "Anyone"`. The warning `Pull request rules can check out unvetted code from strangers. Issue text can also carry prompt injection. Use the narrowest suitable permission mode below.` appears. Set `Review mode` (`find role combobox click --name "Review mode"`, then option `Live — post to GitHub`) with `PR ready for review` on, and the footer shows `Live reviews from any author`. Do not save. Choose `find role button click --name "Cancel" --exact`; the list returns and `"$TB" slopcop rules` lists no `verify-ui`.
- **Lens and agent sections.** In a new form, the `Agent settings` region opens in edit mode with `Close agent settings`, combobox `Project` (`Choose a project`), combobox `Workspace` (`Choose a machine`, disabled until a project is chosen), the `Model & reasoning` picker (a button `Provider, model and reasoning`, prefilled with the instance default such as `codex · gpt-6-astra · high reasoning`, disabled until a project is chosen), and `Permissions` (`Permission mode`). The `Review lenses` region shows `Deep lenses (A, F, G, H, J)` and `Mechanical lenses (B, C, D, E, I, K)`, each a `Provider, model and reasoning` button, while a PR trigger is on, and disappears when only `New issue` is selected. Driving bb's model picker is not needed for the recipes below. <!-- unverified: choosing a model in bb's picker and saving a UI-created rule -->
- **Edit and save.** Choose the `verify-agent` name link (`find role button click --name "verify-agent" --exact`; without `--exact` it is ambiguous once `verify-agent2` exists). The form heading reads `Edit rule`, and `Agent settings` shows `Change agent settings`, `claude-code · claude-opus-5 · high reasoning`, and `Project default`. The form also has `Delete rule` and `Test this rule`. Change `Rule name` to `verify-agent2` and choose `Save rule`. The toast reads `Saved 'verify-agent2' in shadow mode — it reviews but posts nothing.` Confirm with `"$TB" slopcop rules --json | jq -c '.[] | {name, conditions}'`, which lists `verify-agent2` with `[{"kind":"paths","globs":["src/**"]},{"kind":"exclude_author","logins":["dependabot[bot]"]}]`.
- **Unsaved edits block testing.** Reopen `verify-agent2` and change its name without saving. Open `Test this rule` (`find role button click --name "Test this rule"`); it shows `Save your changes before testing this rule.` Choose `Cancel` (`--exact`).
- **Draft restore.** Open `verify-agent2`, click `find role textbox click --name "Review instructions"` and `keyboard type "verify draft text"`, then remount the page without a full reload: choose `find role link click --name "Settings (Ctrl + ,)"` (Settings replaces the sidebar, so there is no SlopCop button there), then `agent-browser --session "$RUN" back`. The URL returns to `/plugins/slopcop/slopcop`, the `Edit rule` form is open, and `verify draft text` is still there. `Cancel` drops it without saving. A full `open` reloads the bundle and drops the draft. That is expected, not a gap.
- **Delete.** Open `verify-noagent` later, after the gh-read tier uses it. `Delete rule` deletes at once, with no confirmation and no toast, and returns to the list; `Rules` drops by one and `"$TB" slopcop rules --json | jq length` agrees. The rule's runs stay in Activity. The CLI twin is `"$TB" slopcop rules rm <rule>`, which prints `Deleted '<name>'.`
- **Empty runs.** On a fresh instance, `"$TB" slopcop runs` prints `No runs yet.`, and `"$TB" slopcop show` and `"$TB" slopcop verify` exit 1 with `no such run`.
- **Review argument errors (no GitHub call).** Each prints the error and exits 1:
  - `"$TB" slopcop review 1 --event approve --body x` gives `expected --repo owner/repo`.
  - `"$TB" slopcop review 1 --repo verify-none/x --body x` gives `--event is required: approve, request-changes, comment`.
  - `"$TB" slopcop review 1 --repo verify-none/x --event bogus --body x` gives `unknown --event 'bogus'; expected approve, request-changes, comment`.
  - `"$TB" slopcop review 1 --repo verify-none/x --event comment` gives `--body is required: the overall review comment`.

  Never pass a valid repo, event, and body together: that posts a real review.

- **Settings.** Open `"$URL/settings/plugins/slopcop"` and `wait --text "Poll interval (seconds)"`. The page lists bb's switch `Disable slopcop`, textboxes `Poll interval (seconds)`, `Max concurrent review threads`, `Path to the gh binary`, `Bot gh wrapper`, and `Default review thread section`, and the switch `Settle finished review threads`.
  - Run `"$TB" plugin config slopcop set pollSeconds 30`. `"$TB" slopcop status` now prints `polling every 30s`. A value below 15 falls back to `60`.
  - Run `"$TB" plugin config slopcop set defaultThreadSection verify-section`. `status` prints `default section: verify-section`.
  - Toggle `Settle finished review threads` with `find role switch click --name "Settle finished review threads"`. Then `"$TB" plugin config slopcop --json | jq .values.settleFinishedThreads` prints `false`; toggle again for `true`.
  - Restore every value recorded in the settings check.
- **Source Control RPC (local state only).** Run `"$TB" plugin rpc list slopcop`, which lists `pullRequestReview` and `runPullRequestAgain` with their descriptions. Write `{"repo":"verify-none/verify-x","number":1}` to `"$FX/pr.json"`, then:
  - `"$TB" plugin rpc call slopcop pullRequestReview --input-file "$FX/pr.json" --json` returns `state: "none"`, `canRunAgain: false`, and `reason: "No enabled SlopCop rule reviews pull requests in verify-none/verify-x."`
  - `runPullRequestAgain` with the same input returns `ok: false` with that message, and reads nothing from GitHub.
- **Needs configuration.**
  - Run `"$TB" plugin config slopcop set ghPath /nonexistent/verify-gh` and `"$TB" plugin reload slopcop`.
  - `"$TB" slopcop status` prints `gh: NOT AUTHENTICATED`, and the page header shows `gh not authenticated`.
  - `"$TB" plugin list --json | jq -c '.plugins[] | select(.id=="slopcop") | {status, statusDetail}'` prints `status: "needs-configuration"` and `statusDetail` `` `gh` is not authenticated on this machine. Run `gh auth login`, then reload the plugin.`` A missing binary reaches this branch; the service does not crash.
  - Restore `ghPath` (mirrored default `gh`) and reload. `status` prints `gh: <login>` again.
- **Skill.** The plugin ships the `slopcop` skill. Run `"$TB" skill list --json | jq -c '.skills[] | select(.name=="slopcop") | {name, pluginId}'`, which prints `{"name":"slopcop","pluginId":"slopcop"}`; its description starts `Configure automated GitHub issue and PR rules with the \`bb slopcop\` CLI.`
- **Environment provider.** Run `"$TB" environment providers --json | jq -c '.. | objects | select(.id? == "slopcop-review") | {displayName, pluginId, requires}'`, which shows `displayName: "Slopcop PR worktree"`, `pluginId: "slopcop"`, and `requires.gitRemote: true`.

### `gh` read only

- **Check.** First run `"$TB" slopcop rules edit verify-noagent --repo <owner/repo> --disabled`, so the watcher ignores this rule. Then:
  - `"$TB" slopcop check verify-noagent <n>` prints `NO MATCH — rule is disabled` and exits 0 (a `NO MATCH` is not an error).
  - Enable the rule, and the output gives the real reason such as `NO MATCH — missing required label bug`, `NO MATCH — author @… is CONTRIBUTOR, and this rule only handles authors with write access (OWNER, MEMBER, COLLABORATOR)`, or `MATCH — 'verify-noagent' would handle PR #<n> (<title>) in shadow mode.` The rule's `--label bug` condition usually decides it.
  - `"$TB" slopcop check verify-noagent <n> --json | jq -c '{matched, reason, target}'` gives the structured form: `matched: false`, the reason, and `target` with `kind`, `number`, `title`, `author`, and `association`.

  Disable the rule again right after. An enabled rule on a real repo bootstraps that repo's backlog on the next poll. The rule has no agent, so any watcher dispatch would only record a `failed` run.

- **CLI dispatch refusal, then a forced run with no agent.** With `verify-noagent` disabled, `"$TB" slopcop dispatch verify-noagent <n>` exits 1 with `'verify-noagent' does not match PR #<n>: rule is disabled` and `Re-run with --force to dispatch anyway.` Run `"$TB" slopcop dispatch verify-noagent <n> --force`, which prints `Dispatched verify-noagent for PR #<n> (shadow mode). run=run_… thread=none`.
  - Run `"$TB" slopcop runs --rule verify-noagent --json | jq '.[0] | {status, detail, threadId}'`. It prints `failed`, `rule has no agent configuration — open it in the SlopCop panel and save it once`, and `null`. No thread was spawned.
  - In the Activity tab (now `Activity 1`), the row shows a `failed` badge, `PR #<n> <title>`, `verify-noagent`, `shadow`, `manual`, the age, and that detail, with no `thread` link.
- **Show and verify on that run.** `"$TB" slopcop runs` prints `failed  verify-noagent  PR #<n> <title>` with the detail on the next line. `"$TB" slopcop show` (exit 0) prints `verify-noagent — PR <owner/repo>#<n> <title>`, `status: failed (shadow — nothing was posted)`, the detail, and `(no comments recorded)`. `"$TB" slopcop verify` exits 1 with `shadow runs post nothing, so there is nothing on GitHub to verify`.
- **Dry run blocked (UI, on the agent rule).** `Run now` never renders for `verify-noagent`: its stored agent is `null`, so the editor always counts as unsaved and `Test this rule` shows the save notice (see Gotchas). Use the agent rule instead.
  - Run `"$TB" slopcop rules edit verify-agent2 --repo <owner/repo> --disabled`, then open `verify-agent2` from the `rules` tab.
  - Open `Test this rule`. It shows a textbox `PR #` and a `Dry run` button, disabled until a number is typed. Run `agent-browser --session "$RUN" find placeholder "PR #" fill <n>`, choose `Dry run`, and `wait --text "would skip"`.
  - A block reads `This rule would skip PR #<n>: rule is disabled`, with `Run anyway` and `The agent will process this target without a public post.` Capture it.
- **Run anyway.** <!-- unverified: not clicked; the missing-section route was not tried because a wrong guess starts a paid review --> Choose `Run anyway` only in one of two cases:
  - The paid tier's preconditions hold, because it starts a review. The toast reads `Forced verify-agent2 on PR #<n>`.
  - `defaultThreadSection` was set to a section the instance lacks, for example `verify-section` from the settings recipe. The section lookup then fails before any spawn, so the run costs nothing. `runs --rule verify-agent2 --json | jq '.[0].detail'` prints `no thread section named 'verify-section'. Available: …`.

  Restore the section setting afterwards.

- **PR state after a run.** Write `{"repo":"<owner/repo>","number":<n>}` to `"$FX/pr.json"` and call `pullRequestReview`. It returns `{"state":"failed","finishedAt":"<iso>","findings":0,"canRunAgain":false,"reason":"No enabled SlopCop rule reviews pull requests in <owner/repo>."}` while the rules are disabled.

### Fake-agent turn (free, shadow, nothing posted)

The free local fake agent (SKILL.md **Free agent turns**, provider `acp-verify-fake`) drives the dispatch plumbing for an issue rule without a model. It cannot produce a review a real model would write, so `shadowed` stays with the paid tier below.

- **Rule on the fake provider.** Create a fixture project, then `"$TB" slopcop rules add --name verify-issue --repo <owner/repo> --project <fixture project> --trigger new_issue --provider acp-verify-fake --model acp-default --reasoning medium --permission full --disabled --json`. `.agent` shows `providerId: "acp-verify-fake"` and `model: "acp-default"`.
- **No header or marker.** Write `verify fake shadow reply` to `$EV/reply.md`, then `"$TB" slopcop dispatch verify-issue <issue-number> --issue --force --json`, which prints `runId` and `threadId`. The thread is titled `SlopCop (shadow): verify-issue — Issue #<issue-number>` (visible, unsectioned). After `"$TB" thread wait <threadId>`, `runs --rule verify-issue --json` shows `commented_unattributed` with `shadow review is missing both the header and the marker — the prompt contract was not followed`. `"$TB" slopcop show <run-id>` prints `status: commented_unattributed (shadow — nothing was posted)` and a `--- summary [account] ---` block holding the reply.
- **Header without a valid marker.** Write `` 🚨 **SLOP COP** 🚨 · `verify-issue` `` then a blank line and `{{ECHO}}` to `reply.md` and dispatch again. The run is `commented_unmarked` with `shadow review has the SlopCop header but no valid marker — it would post unattributably if promoted to live`, and `show` labels the block `--- summary [header] ---`. The prompt carries the run's marker (`<!-- slopcop:rule=<rule> run=<run-id> sha=issue-<n> kind=summary -->`) but the echo does not end with it.
- **Activity.** Both rows show the status as words (`commented unmarked`, `commented unattributed`), `issue #<n> <title>`, the rule, `shadow`, `manual`, the age, a `thread` button, and `1 comment`. Choosing `1 comment` expands the stored body under `summary`; choosing `find role button click --name "thread" --exact` opens `/projects/<pid>/threads/<threadId>`.
- Neither status settles the thread (`archivedAt` stays `null`), matching the setting's description that runs with attribution problems stay open.
- Cleanup: `rules rm verify-issue` and delete the fixture project; the runs remain.

### Paid agent turn (real model, shadow, nothing posted)

<!-- unverified: every step in this tier needs a real model's review; `shadowed`, settle, and archive-before-report were not reached -->

- **Precondition.**
  - The rule's provider and model (the CLI default is `claude-code` / `claude-opus-5`) are usable on the test host.
  - `defaultThreadSection` is empty or names a section on the test instance.
  - The user has approved the model spend. <!-- unverified: the cost of one PR review, whose orchestrator launches eleven lens subagents -->
- **Checkout for a PR run.** A PR run spawns its thread in the `Slopcop PR worktree` environment, which requires the project to have a git remote. The host finds or partially clones that repository and checks out GitHub's `refs/pull/<n>/head`. The empty `verify-sc` fixture has no remote, so a PR dispatch on it fails, with the environment error in the run's `detail`. <!-- unverified: whether that failure lands before or after a turn starts -->
  - For a PR shadow review, create a second fixture project from a clone of `<owner/repo>`, so that `origin` points at GitHub, and point the rule at it with `rules edit verify-agent2 --project <that project>`.
  - Issue runs use the project default and work on `verify-sc`.
- **Issue route (simplest).** Run `"$TB" slopcop rules add --name verify-issue --repo <owner/repo> --project verify-sc --trigger new_issue --disabled`, then `"$TB" slopcop dispatch verify-issue <issue-number> --force --json`. It prints `runId` and `threadId`. The thread is titled `SlopCop (shadow): verify-issue — Issue #<issue-number>`, and Activity shows `reviewing` with a `thread` link that opens it.
- **PR route.** On the cloned project, run `"$TB" slopcop dispatch verify-agent2 <n> --force --json`. The thread is titled `SlopCop (shadow): verify-agent2 — PR #<n>`.
- **Shadowed.** When the thread goes idle, the run becomes `shadowed`. `"$TB" slopcop show <run-id>` prints the stored body, which starts with `🚨 **SLOP COP** 🚨 · \`<rule>\``and carries a`<!-- slopcop:rule=… run=<run-id> … -->`marker, tagged`[marker]`. A missing marker gives `commented_unmarked`or`commented_unattributed`, with the reason in `detail`.
- **Settle.** A PR review thread stays open until its PR is merged or closed. A `shadowed` issue run settles when `settleFinishedThreads` is on: `"$TB" thread show <thread-id> --json | jq .thread.archivedAt` prints a timestamp. With the setting off, it stays `null`.
- **Archive before report.** Archive a run's thread while it is still `reviewing` (`"$TB" thread archive <thread-id>`). The run becomes `failed` with `review thread archived before it reported`. Deleting the thread instead gives `review thread deleted before it reported`.

### GitHub writes and watcher events

<!-- unverified: needs GitHub writes and paid turns -->

- These need a disposable GitHub repository, a `gh` identity that may write to it, and paid turns. The routes are:
  - `rules edit <r> --live` with `dispatch`, then `verify <run-id>`, which re-matches comments by marker.
  - A new ready PR or a new commit, a new issue (`--trigger new_issue`), or a `@keyword` comment, each with the watcher enabled.
  - A valid `bb slopcop review` from inside the review thread.
- Report them as unreachable without that repository and approval.

### Cleanup (every run)

- Run `"$TB" slopcop rules rm <name>` for each `verify-…` rule this run created.
- Restore the recorded settings, and run `"$TB" plugin reload slopcop` if you changed `ghPath`.
- Run `"$TB" project delete <project-id> --yes` for each fixture project, which also removes its review threads, and remove `$FX`.
- Runs cannot be deleted (see Gotchas).

## Gotchas

- **Personal `gh` login.** Without `botGhPath`, every read and every post uses the host's own `gh` login, and the page header shows that login. Never run `--live` or a valid `review` without approval. Keep the login out of evidence text where possible.
- **The watcher runs on the test instance.** Any enabled rule on a real repo is polled every `pollSeconds`. The first pass only records the backlog, but a later ready PR, commit, issue, or keyword comment dispatches a paid thread. Keep fixture rules disabled, or on an unresolvable slug, except during a check.
- **Runs outlive their rule.** `rules rm` and `Delete rule` keep the rule's runs, no command deletes runs, and the instance's plugin database persists across `sync`. Never assert `No runs yet.` or an exact Activity count on a reused instance. Select runs by rule name with `runs --rule` before deleting that rule.
- **`gh` login read once.** The `gh` login shown in the header and in `status` is read when the watcher starts. After changing `ghPath` or `botGhPath`, run `"$TB" plugin reload slopcop` before you expect `status` to change.
- **Missing section.** A mirrored `defaultThreadSection` that names a section the test instance lacks fails every spawning dispatch with `no thread section named '…'. Available: …`.
- **No `Run now` without an agent.** A rule saved without an agent, for example from `rules add` with no `--project`, never shows `Run now`: freshly opened with no edits, `Test this rule` still shows `Save your changes before testing this rule.` The editor compares its placeholder agent with the stored `null` and always reports unsaved changes. Saving from the UI requires choosing an agent, which fixes it. This is a product gap (misleading notice).
- **Run anyway with an agent.** On a rule with an agent configured, `Run anyway` and `dispatch --force` start a paid review unless a missing section stops them first. Use CLI `dispatch --force` on the no-agent rule for free proof of the dispatch path.
- **Hover.** Headless Chrome reports `(hover: none)`, and the cards' hover tint is unreachable. Drive every control by role and name. Only the name link opens the editor; the rest of the card does not.
- **Label flags.** `rules edit --label` and `--skip-label` add a new condition on each call instead of replacing the old one, whereas `--paths`, `--base`, and `--exclude-author` replace theirs. Expect duplicate label chips after repeated edits.
- **Save validates agent settings.** A rule created in the UI cannot save until a project and model are chosen in bb's picker. Recipes create rules with `--project` from the CLI, which stores `Project default` as the workspace.
- **Placeholder names.** The `Run now` field has no label; target it by its placeholder, `PR #` or `issue #`.
- **CLI rules start enabled.** `rules add` without `--disabled` creates an enabled rule, so a real slug is polled from the next pass. Pass `--disabled` or disable at once.
- **`--exact` for names.** Rule names that prefix each other (`verify-agent`, `verify-agent2`) and the editor's `Cancel` (which also matches other buttons) need `find role button … --exact`.
- **Shared run history.** Runs from earlier verifications stay in the instance's SlopCop database, and runs cannot be deleted. Select by `--rule`.
