# Review

Independent design and implementation reviews by the other model family, with fixed source targets and a composer banner.

## Modes and triggers

| Mode     | Effort  | Scope                                                                        |
| -------- | ------- | ---------------------------------------------------------------------------- |
| Quick    | Medium  | Bounded adjustments and checking fixes                                       |
| Standard | High    | Stable implementation checkpoints and consequential design choices           |
| Deep     | Maximum | Material failure analysis; required before shipping or opening/updating a PR |

Reviews do not trigger just because a turn ends. During user iteration, agents prefer focused checks and a reviewable preview. Consequential architecture and plans should be reviewed before expensive dependent implementation. Review a publication candidate once and reuse its completed run at push, PR update, and merge while the candidate is unchanged. A Deep design review does not replace final Deep implementation review. Complete review coverage applies only to its exact candidate; blocking findings must still be resolved and limits reported. This plugin supplies instructions and revision-bound results, not an interceptor for external publication commands.

Review criteria follow the actionable-bug focus of [Codex’s review rubric](https://github.com/openai/codex/blob/669449b02c4b58de4bcd22485eb60c98a6e38a54/codex-rs/prompts/templates/review/rubric.md) and [Claude Code’s code-review plugin](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/commands/code-review.md). This plugin supplies a short shared prompt with BB target, read-only, and result contracts; it does not invoke either native review workflow. Modes select effort without adding audit checklists.

## Manual commands

Users can invoke `/review-quick`, `/review-standard`, or `/review-deep` with an optional branch, plan, or focus. Claude skills disable model invocation; their Codex policy disables implicit invocation. Agents use the native tools or CLI directly.

## Agent tools

`review_start({kind?, mode?, summary, scope?, target?, brief?, evidence?, workstream?, reuse?})` starts a run. Defaults: implementation, standard, reuse:auto. Implementation requires a target: `{branch}` or `{base, head, upstream?}`. Design can use an immutable inline proposal without repository context. Keep the summary short; the optional brief and captured UTF-8 evidence `{label,path}` are disclosed lazily. Evidence files are read on the calling host, limited to eight references of 12 KiB each, and retain a content hash. State the revision or combined-workspace state that produced tests/captures.

`review_context({runId, section, path?, side?, offset?})` reads bounded pages of brief, evidence, diff, tree, file, or completed report. Follow `nextOffset` for complete content. Applicable repository instructions are available as pinned files. Deep implementation review reads the complete scoped diff.

BB notifies the parent when the reviewer completes or fails. Retrieve the result once with `review_result({runId, waitSeconds:0})` after notification; do not poll. The tool reads only the successfully completed turn associated with this run. Failed, unfinished, redirected, or unstructured responses cannot clear the candidate. `current` checks whether the target still resolves to the same base/head. `deepImplementationCovered` requires publication scope, complete diff coverage, a current Deep implementation result with matching execution, and no P0/P1 findings. Descendant helper threads in the same project and environment may read and inherit an unchanged completed publication assessment; a changed candidate needs a new run. It does not authorize publication or replace resolving valid findings.

## GitButler targets

Implementation targets require Git 2.41 or newer for pinned attribute handling; the snapshot checks this before dispatching a reviewer. The host entry uses `but status --json` to select only the named applied branch's owned commits. Its oldest commit's parent is the review base, preserving lower stack commits as dependency context. The branch ref must match its newest owned commit. Empty, unapplied, or conflicted branches require a suitable checkpoint or explicit base/head. Raw HEAD and gitbutler/workspace selectors are rejected. Source is read from immutable Git objects; no checkout, unapply, commit, or workspace mutation is performed.

Checkpoint only owned or otherwise authorized files/hunks before implementation review. Other agents may continue working in the same checkout. Unrelated workspace changes do not invalidate an unchanged reviewed candidate. Unchanged source, scoped diffs, and dependency context are read at the pinned commits rather than from the mutable workspace.

## Reuse

Each assessment has a new run ID. Auto reuse in every mode requires the same parent, environment, reviewer provider/model, and workstream, an idle unarchived reviewer, and context below 60% of its model window. The branch identifies the workstream by default; an explicit workstream label supports design-to-implementation reuse. Busy reviewers are not redirected. Choose `reuse:new` for fresh judgment or `{threadId}` for a specific eligible reviewer. Previous knowledge is useful; previous approval does not cover a new candidate.

## CLI

```sh
bb review start --mode standard --branch scott/feature --prompt 'Check the new routing behavior'
bb review start --kind design --mode quick --file /absolute/plan.md
bb review start --mode deep --scope publication --base <base> --head <head> --prompt 'Final implementation review' --json
bb review result <run-id>
bb review context <run-id> --section diff
```

Use exactly one of `--prompt` or `--file`. File paths name files on the calling host. `--review-thread` chooses a reviewer explicitly; `--reuse new` requests a fresh one.

Settings `claudeModel` and `codexModel` choose the reviewing models. Effort is selected by mode. The banner shows the latest run's mode, purpose, and elapsed time, and preserves navigation back to the main thread.

For shipping or opening/updating a PR, request a **Deep implementation** run with `scope: "publication"` (`--scope publication` in the CLI). Branch publication scope pins merge-base to that branch tip, including its ancestor stack segments and excluding other applied stacks. Explicit publication base/head must start at the current GitButler workspace merge base; Outside GitButler, publication scope requires `{base,head,upstream}` (CLI `--upstream origin/main`), with base equal to the merge base of the candidate and the declared destination branch. Deep can reuse an eligible idle reviewer for a follow-up, with a new maximum-effort turn and complete reads of the new candidate. Identical completed requests may return their unchanged result; `reuse:new` forces fresh judgment. The result gate requires a current candidate, matching execution, every diff page served to the reviewer, complete output, and no P0/P1 findings.

Context pages are 16,000 characters; each pinned Git read is limited to 8 MiB and fails explicitly above that limit. A failed or partial Deep read cannot clear publication. The banner shows Awaiting result until the author reads the assessment; metadata polling stops when it is assessed.
