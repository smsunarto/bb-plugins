---
name: slopcop
description: Configure automated GitHub issue and PR rules with the `bb slopcop` CLI. Use for new-issue listeners, pull-request reviews, rule changes, author restrictions, match checks, and shadow results.
---

# SlopCop — automated GitHub issue and PR rules

- A **rule** watches one GitHub repo and dispatches a BB agent for matching pull requests or new issues. Configure rules from the CLI on the user's behalf.

## Safety defaults — do not loosen without being asked

- Keep the trust and shadow defaults unless the user explicitly asks to change them.
- **`--trust write_access`** (default) reviews only `OWNER`, `MEMBER`, and `COLLABORATOR` authors.
- GitHub's `CONTRIBUTOR` means only that an author has had a commit merged; it does not imply write access. `--trust past_contributors` includes those authors, and `--trust anyone` includes strangers' forks.
- Reviewing untrusted PRs exposes the agent to attacker-controlled source and diff content.
- **Shadow mode** (default for new rules) runs the full review and stores its body without posting. Promote with `--live` only after the user has seen a shadow result and asked for it.

- For organization-member reviews, use `--trust org_members`: it admits `OWNER` and `MEMBER` authors and excludes outside `COLLABORATOR` authors. Enroll each intended repository separately.
- Use only `ready_for_review,new_commits` to exclude external PRs entirely. Comment triggers check the requester instead of the author; use `--requester-trust org_members` to restrict requesters.

## Creating a rule

- Supply a repository and an agent configuration (`--project` at minimum); both are required to dispatch:

```sh
bb slopcop rules add \
  --name security-sweep \
  --repo owner/repo \
  --project <bb-project-name> \
  --model claude-opus-5 \
  --paths "src/auth/**,src/payments/**" \
  --base main \
  --prompt "Review the diff for auth and payment issues."
```

- Flags: `--name --repo --project --provider --model --reasoning --permission
--prompt --paths --base --label --skip-label --trust --dedupe --strategy
--trigger --keyword --requester-trust --live --shadow --disabled --hidden
--visible`.

- Use `--exclude-author "username,dependabot[bot]"` to replace excluded PR authors, or `--exclude-author ""` to clear them. Matching ignores case and an optional `@`.
- Author exclusions also apply to comment-triggered PR reviews; issue rules are unaffected. `dispatch --force` can override the filter.
- To run only after a request, use `--trigger comment_matches` with a literal `--keyword "@slopcop"`. Add `pr_description_matches` to check the initial ready PR description.
- Use `--dedupe once_per_trigger_event` to allow one review per new request. Comment requesters default to `write_access`.
- Use `--trigger new_issue` for new issues. The first poll records the open backlog; labels, authors, and titles can filter issues, while PR-only conditions do not restrict them.
- Use `--hidden` for frequent background rules: threads use `visibility: "hidden"`, stay out of sidebar organization, and raise no unread or notification attention. The default `--visible` keeps new rules watchable while tuning.
- Set the default section for new review threads with a section name or ID:

```sh
bb plugin config slopcop set defaultThreadSection "Automated reviews"
```

- Clear `defaultThreadSection` to create threads without a section. A configured section that no longer exists makes the run fail explicitly.
- Permission modes are `full`, `auto` (default), and `accept-edits`. BB has no read-only permission mode; retain the trust gate.

## Inspecting and debugging

```sh
bb slopcop rules                       # list rules
bb slopcop status                      # gh auth, watched repos, poll interval
bb slopcop check <rule> <number> [--issue]
bb slopcop runs [--rule <r>] [--json]  # recent runs and their status
bb slopcop show [run-id]               # the review body a run produced
bb slopcop dispatch <rule> <number> [--issue] [--force]
bb slopcop rules edit|enable|disable|rm <rule>
```

- `bb slopcop review [number] --repo owner/repo --event approve|request-changes|comment --body <md> [--comments <json>]` submits one GitHub review, with its verdict and inline comments, through SlopCop's `gh` identity. In a SlopCop review thread it defaults to the run's PR and reviewed head and refuses shadow runs; `--help` documents the comment fields.
- Use `check` to diagnose why a PR was not reviewed. It reports the decisive reason, such as draft state, trust gate, or a condition.

## Run statuses

- `shadowed`: review produced; nothing posted.
- `commented`: GitHub posting verified by marker.
- `commented_partial`, `commented_unmarked`, `commented_unattributed`: posted with degraded attribution; the prompt contract slipped.
- `no_comment`: thread finished without posting.
- `skipped`: a rule matched nothing, such as a trust-gate rejection.
- `failed`: the thread errored or was archived/deleted before reporting.
- Every posted comment carries the visible `🚨 SLOP COP 🚨` header and a hidden `<!-- slopcop:… -->` marker. Verification polls GitHub for the marker instead of trusting the transcript.

## Launch reviewers and their lenses

### Ownership

- For saved PR rules, use [orchestrator-role.md](references/orchestrator-role.md). Keep repository-specific tooling guidance in the rule's context section.

- The Slopcop orchestrator owns two direct Review children: Claude and Codex. It validates their reports and posts under the rule's live/shadow policy.
- Each Review parent owns eleven separate lens children: A,B,C,D,E,F,G,H,J,K,I. Lenses are leaves in the BB thread tree; they may use tool subagents within their assigned lens but cannot create BB subthreads. The orchestrator does not repeat their reviews.

### Reuse the orchestrator worktree

- Slopcop dispatches the orchestrator into a native BB worktree of the PR branch. Every reviewer and lens reuses that environment and worktree; no agent creates a separate checkout.
- Pin the checked-out PR head for the run. Read base evidence with `git show` and `git grep` at the base revision without switching the worktree.
- Resolve this skill's installed directory on the checkout host, then run the helper below. The helper defaults to its current working directory and does not fetch or change revisions; children verify base and head before reading.

```sh
python3 <slopcop-skill-directory>/scripts/start_review.py \
  --repository owner/repo --pr-number 123 \
  --base-sha <full-base-sha> --head-sha <full-head-sha> \
  --context-file /path/to/context.txt
```

- Run the helper in the orchestrator worktree. `--checkout` remains available as an explicit path override.
- Put repository guidance and any conditional tooling appendix in the optional context file.
- Routing defaults to `BB_PROJECT_ID`, `BB_ENVIRONMENT_ID`, and `BB_THREAD_ID`. Override with `--project`, `--environment`, and `--parent-thread`.
- Each reviewer receives a runnable `--mode lenses --provider claude-code|codex` command that parents leaves to its actual ID. Models and permissions use BB's inherited defaults, with high reasoning; each lens uses its reviewer's provider.

- Native worktree creation fetches the selected remote branch. A fork head referenced only by SHA must already be available in the project repository; provisioning fails if it is unavailable, rather than asking agents to prepare it.

### Review evidence

- In every role, do not read existing human or agent reviews, review comments, or discussions in the PR. Do not inspect GitHub CI checks, commit statuses, workflow runs, logs, or artifacts.
- Use pinned source and task context; parents may synthesize their assigned children's reports returned through BB. Pass these restrictions to every tool subagent.

### Communication

- Give each child its complete assignment at launch. Children report by ending their turns; BB automatically notifies their parents (`--parent-notifications auto`).
- Do not message or steer peers, parents, or children with `bb thread tell` or follow-up tools. Read completed reports with `bb thread output`; report unresolved gaps without a messaging loop.
- Parents with unfinished children end their turn with only `<!-- slopcop:awaiting-children -->` and remain idle until BB automatically resumes them. Do not sleep, use child wait tools, or poll; read a child's report after its notification, treating the same pending-state signal as unfinished work.
- Slopcop keeps pending-state turns open through idle events and reload reconciliation. Final review reports use the normal delivery format; preserve child IDs and collected results across interim turns.
- Lenses may launch tool subagents within their single lens and must collect their completion notifications and results before reporting. Those subagents inherit the read-only worktree and communication boundaries; they cannot create BB subthreads.

### Handle failures

- Record the JSON target, parent, provider, role, lens ID, child IDs, and errors. Partial failure exits nonzero and preserves successful IDs.
- Each BB subprocess has a 60-second deadline. A timeout or malformed response can leave an unknown launch outcome; reconcile direct children by parent and unique `review_run` in their titles before retrying.
- After reconciling a known failed launch, use `--lens <ID>` to retry only that lens. Do not rerun successful fanout.
- A reviewer may run a separate sequential pass only for an actual failed lens launch and must report the exact error. Treat missing or incomplete reports as coverage gaps.

### Validate and clean up

- The helper only launches. For notification-driven completion, evidence validation, synthesis, attestation, and lens cleanup, follow [reviewer-role.md](references/reviewer-role.md).
- The orchestrator consumes both reports and checks all eleven attestation rows under each reviewer. It then archives and stops only its two direct children.
- Every launch assigns lifecycle ownership to its parent; archiving a failed reviewer also archives/stops its lenses.
- Verify cleanup once with `bb thread show <id> --json`: `.thread.archivedAt` must be set, and neither `.thread.status` nor `.thread.runtime.displayStatus` may be starting, active, or stopping.
- Report unresolved cleanup and coverage failures.

### Preference assets and role boundaries

- Keep [review_profile.md](references/review_profile.md) and [appendix.md](references/appendix.md) unchanged. They contain user preferences, separate from operational roles.
- The helper inserts the profile verbatim for reviewers and the profile immediately followed by the appendix verbatim for lenses. Lens definitions come from the profile, one child per definition, without grouping.
- Slopcop children do not use `bb review prompt`. The independent local `request-review` workflow is unchanged.
- For pinned source access, read [checkout-role.md](references/checkout-role.md). For role ownership, read [reviewer-role.md](references/reviewer-role.md) or [lens-role.md](references/lens-role.md), as applicable.
- These wrappers assign fanout only to Review parents, restrict leaves to one lens, and read base evidence by revision while keeping the shared worktree at head.
- Role files are complete prompt templates: `{checkout_instructions}` inserts the shared checkout contract, `{review_profile}` inserts the unchanged profile, and the lens template places `{appendix}` immediately after it. The helper fills tags once; braces inside inserted assets remain literal.

### Provenance and verification

- Source: [supplied profile and appendix](https://pastebin.com/raw/AAr9MUpE). The approved adaptation changes Devin session/address terms to BB lens threads, maps each source sweep to one lens, and replaces diff attachments with base/head checkout reads.
- The extracted assets exclude outer automation, fixes, and compute-budget procedures. At the user's request, review-count targets and caps were removed, and base-checkout reads now use pinned base revisions from the shared head worktree; brevity, evidence, and deduplication guidance remain.
- Tests pin both approved assets' SHA-256 digests and exercise real CLI calls through fake BB: copied skill installation, parent/provider routing, exact prompt bytes and order, failures, and cleanup.
- To verify the helper and assets, run:

```sh
python3 -m unittest discover -s plugins/slopcop/skills/slopcop/scripts -p 'test_*.py'
```
