---
name: slopcop
description: Configure automated GitHub issue and PR rules with the `bb slopcop` CLI. Use for new-issue listeners, pull-request reviews, rule changes, author restrictions, match checks, and shadow results.
---

# SlopCop — automated GitHub issue and PR rules

A **rule** watches one GitHub repo and dispatches a BB agent for matching pull
requests or new issues. Configure rules from the CLI on the user's behalf.

## Safety defaults — do not loosen without being asked

Two defaults exist to stop the agent running untrusted code, and you should
leave them alone unless the user explicitly asks:

- **`--trust write_access`** (default) — only reviews PRs from `OWNER`,
  `MEMBER`, `COLLABORATOR`. Note that GitHub's `CONTRIBUTOR` means only "has
  had a commit merged before", **not** write access; `--trust past_contributors`
  includes those drive-by authors, and `--trust anyone` reviews strangers'
  forks. Reviewing an untrusted PR means the agent runs `gh pr checkout` on
  unvetted code and reads an attacker-controlled diff into its own prompt.
- **shadow mode** (default for new rules) — the rule runs the full review and
  stores the body, but posts nothing. Promote with `--live` only when the user
  has seen a shadow result and asked for it.

For organization-member reviews, use `--trust org_members`. It admits GitHub
`OWNER` and `MEMBER` authors and excludes outside `COLLABORATOR` authors. Each
rule targets one repository; enroll all intended repositories. Use only
`ready_for_review,new_commits` to exclude external PRs entirely. Comment triggers
check the requester instead of the author; set `--requester-trust org_members`
when restricting who can request reviews.

## Creating a rule

A rule needs a repo AND an agent configuration (`--project` at minimum), or it
cannot dispatch:

```sh
bb slopcop rules add \
  --name security-sweep \
  --repo owner/repo \
  --project <bb-project-name> \
  --model claude-opus-5 \
  --paths "src/auth/**,src/payments/**" \
  --base main \
  --prompt "Review the diff for auth and payment issues. Post findings with gh pr review --comment."
```

Flags: `--name --repo --project --provider --model --reasoning --permission
--prompt --paths --base --label --skip-label --trust --dedupe --strategy
--trigger --keyword --requester-trust --live --shadow --disabled --hidden
--visible`.

Use `--exclude-author "username,dependabot[bot]"` to replace a rule's excluded
PR authors, or `--exclude-author ""` to clear them. Matching ignores case and
accepts an optional `@`. Exclusions apply to comment-triggered PR reviews too;
issue rules are unaffected. `dispatch --force` can override this filter.

To run only after a request, use `--trigger comment_matches` and a literal
keyword such as `--keyword "@slopcop"`. Add `pr_description_matches` to check
the initial ready PR description. Use `--dedupe once_per_trigger_event` so each
new request can start one review. Comment requesters default to `write_access`.

Use `--trigger new_issue` to listen for new issues. The first poll records the
open backlog. Labels, authors, and titles can filter issues. PR-only conditions
do not restrict issue events.

`--hidden` spawns review threads with `visibility: "hidden"`: they stay out of
sidebar organization and raise no unread or notification attention. Right for a
rule that fires often. Default is `--visible`, so a new rule is watchable while
you tune it.

Set a default BB section for all new review threads with a section name or ID:

```sh
bb plugin config slopcop set defaultThreadSection "Automated reviews"
```

Clear `defaultThreadSection` to create review threads without a section. A run
fails with an explicit error if the configured section no longer exists.

Permission modes are BB's own: `full`, `auto` (default), `accept-edits`. There
is no read-only mode, which is why the trust gate is the real protection.

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

`check` is the right tool for "why didn't SlopCop review my PR?" — it reports
the single decisive reason (draft, trust gate, a specific condition).

## Run statuses

`shadowed` (shadow review produced, nothing posted) · `commented` (verified on
GitHub by marker) · `commented_partial` / `commented_unmarked` /
`commented_unattributed` (posted but attribution degraded — the prompt contract
slipped) · `no_comment` (thread finished without posting) · `skipped` (a rule
matched nothing, e.g. blocked by the trust gate) · `failed`.

Every comment SlopCop posts carries a visible `🚨 SLOP COP 🚨` header and a
hidden `<!-- slopcop:… -->` marker; verification polls GitHub for that marker
rather than trusting the agent's transcript.
