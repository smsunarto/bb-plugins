# Review

Ask independent reviewers to challenge a change, then synthesize a verdict. The workflow follows [pstack's interrogate skill](https://github.com/cursor/plugins/tree/main/pstack/skills/interrogate): scope, intent, independent reviews, synthesis, and lead judgment.

## Workflow

Agents start reviews automatically when implementation is ready for handoff, after relevant checks and checkpointing authorized changes, and before dependent implementation of consequential designs. Automatic reviews use the default mode unless the user requests another. An explicit request to skip review is respected. These triggers are agent instructions, not a server hook on every turn or commit.

1. Identify the change and state what it should achieve.
2. Start a review with the intent and source target.
3. Collect a cached completed result immediately; otherwise wait for BB's notifications and collect each reviewer's report.
4. Merge duplicate findings, note disagreements, and classify each finding with a reason: **Act on**, **Consider**, **Noted**, or **Dismissed**.

A review request produces a verdict. It does not authorize fixes or publication. The lead reviewer weighs evidence and decides which findings warrant action; severity labels do not automatically veto publication. Reuse a completed, current review for unchanged work. A turn ending, push, PR update, or merge alone does not trigger another review. After addressing findings, review again when it would resolve a material uncertainty.

## Start a review

Use `/review-standard` with a branch, proposal, or focus. These user-only shortcuts select effort:

| Shortcut           | Effort  | Reviewers                                |
| ------------------ | ------- | ---------------------------------------- |
| `/review-quick`    | Medium  | One reviewer from the other model family |
| `/review-standard` | High    | Claude and Codex                         |
| `/review-deep`     | Maximum | Claude and Codex                         |

Each reviewer receives the same intent and rubric in a hidden child thread. The composer banner shows progress and links to the reviewers. Settings `claudeModel` and `codexModel` select their models.

Agents call `review_start({summary, target})`. The default is a Standard implementation review. For a proposal, use `kind: "design"` with `brief`; a repository target is optional.

```sh
bb review start --branch scott/feature --prompt 'Check the new routing behavior' --json
bb review start --kind design --file /absolute/plan.md --json
bb review result <run-id>
```

Use `--json` to read the receipt's status and distinguish a completed cached run from a running review.

## Source and results

For implementation, `target: {branch}` selects the named GitButler branch's tip and reviews from the workspace merge base to that tip. This includes its ancestor branches, but excludes other applied stacks, branches above it, and uncommitted files. The checkout can remain on `gitbutler/workspace`; its combined tree is never the review target. Use `{base, head}` for a narrower comparison. Only checkpoint authorized changes. `HEAD`, `gitbutler/workspace`, and workspace commits are rejected because they combine unrelated work.

Both reviewers read immutable Git objects, so concurrent workspace edits cannot change their source. The host requires Git 2.41 or newer for pinned attributes. No checkout or workspace mutation occurs during review.

Optional `brief` and `evidence: [{label, path}]` provide context. Evidence is captured from the calling host: up to eight UTF-8 files of 12 KiB each. State which revision or workspace produced test results.

If `review_start` returns `status: "completed"`, call `review_result({runId})` immediately; cached runs send no new notification. Otherwise BB notifies the parent when each reviewer finishes. Call `review_result({runId})` after notification; it stays `running` until every reviewer finishes. The result returns one report per model in `reviews`, and `current` indicates whether the source target still matches. Failed or incomplete reviews remain visible as limitations. There is no publication-clearance flag or diff-read ledger.

`review_context({runId, section, path?, side?, offset?})` reads the brief, evidence, diff, tree, pinned file, or full reports. Follow `nextOffset` for additional pages. Pages contain up to 16,000 characters; individual Git reads have an 8 MiB limit. The author, its descendants in the same environment, and the reviewers can read the run.

## Follow-ups

The plugin manages reuse. Repeating an identical request while it is unsettled returns the existing run; an unchanged completed request can return its existing result. Distinct requests can run concurrently. `reuse: "new"` requests fresh judgment. An optional `workstream` label associates a proposal and its implementation; `{threadId}` selects an eligible reviewer explicitly.

A usage-limited reviewer gets one fallback attempt, recorded in its result. A panel seat can move to the other model family; a Quick reviewer switches models on its provider. If no fallback is available, BB's scheduled retry keeps the run queued. Without a retry, the result reports an incomplete review.

Review criteria draw on [Codex's rubric](https://github.com/openai/codex/blob/669449b02c4b58de4bcd22485eb60c98a6e38a54/codex-rs/prompts/templates/review/rubric.md), [Claude Code's code-review plugin](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/commands/code-review.md), and [pstack's code-quality lens](https://github.com/cursor/plugins/tree/main/pstack/skills/interrogate). Implementation reviewers check correctness, root causes, structure, verification, complexity, and security. Design reviewers assess the supplied proposal.
