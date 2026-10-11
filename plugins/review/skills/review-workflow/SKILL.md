---
name: review-workflow
description: Select independent review scope, effort, fixed GitButler targets, and safe follow-up runs.
user-invocable: false
---

Start with `review_start({kind, mode, summary, target?, brief?, evidence?, reuse?})`. `kind` is design or implementation. Modes are quick (medium effort), standard (high), deep (max). `target` is `{branch}` or `{base, head}`. Evidence references are `{label, path}` text files on the calling host. `reuse` defaults to auto; use new for fresh judgment or `{threadId}` for an eligible idle reviewer.

Implementation review requires a checkpoint. A GitButler branch is resolved to immutable base/head commits, with lower stack commits as context. Checkpoint only selected owned/authorized changes; do not commit another agent's work or change the shared checkout. Explicit base/head can name commits or non-workspace refs. Never use HEAD or gitbutler/workspace. A branch with no owned commits requires a checkpoint or explicit comparison. Review relevant consumers at the pinned head, not combined live files.

Design review can use only a short immutable summary and optional brief, or add pinned repository context. Include the consequential choice, constraints, alternatives, assumptions, dependency order, reversibility, and cheap validation. Get feedback before dependent work becomes expensive. Routine planning or iterative previews do not automatically require a review.

Use `review_context({runId, section, path?, side?, offset?})` for progressive disclosure: brief, evidence, diff, tree, file. Follow nextOffset to read complete content. Deep implementation review reads the complete scoped diff. Applicable agent instructions are ordinary pinned files; fetch only relevant principle leaf skills. Evidence is captured at start and includes a content hash; test/capture provenance still needs a stated revision or workspace state.

Use `review_result({runId, waitSeconds?})` with a wait bounded at 60 seconds. Results are matched to the run ID and completion turn; failed, incomplete, superseded, or stale results cannot satisfy the final review requirement. No automatic external publication is performed by this plugin.

Deep implementation review is required before shipping or opening/updating a PR. Reuse the same eligible reviewer for fixes, but start a new run when the candidate changes; Quick fix verification alone does not satisfy the final Deep requirement. An unchanged complete Deep candidate need not be redundantly reviewed. Resolve blocking findings and report verification limits.

Reuse preserves knowledge, not approval. Busy reviewers are not redirected. Auto reuse is limited to the same parent, environment, workstream, reviewer provider/model, and manageable context; choose new for changed scope, stale assumptions, or independent judgment. A design-to-implementation transition can reuse knowledge when its workstream and target match.

CLI: `bb review start --mode quick|standard|deep --kind design|implementation --branch <branch> --prompt <summary>` (or --file <brief>). Explicit comparisons use --base and --head. `bb review result <run-id> --wait 30s` and `bb review context <run-id> --section diff` use run IDs. Use --json for structured output. Manual /review-quick, /review-standard, /review-deep are user-only; agents use tools or CLI.

For shipping or opening/updating a PR, request a **Deep implementation** run with `scope: "publication"` (`--scope publication` in the CLI). Branch publication scope pins merge-base to that branch tip, including its ancestor stack segments and excluding other applied stacks. Explicit base/head must cover the complete publication delta. Outside GitButler, declare target.upstream (--upstream origin/main); base must be the merge base with that destination. Deep follow-ups can reuse an eligible idle reviewer at maximum effort; each run must read and assess its own pinned candidate. Use reuse:new for fresh judgment. The result gate requires a current candidate, matching execution, every diff page served to the reviewer, complete output, and no P0/P1 findings.
