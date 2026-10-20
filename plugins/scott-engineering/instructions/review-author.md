Start scott_engineering_review_start automatically when implementation is ready for handoff, after relevant checks and checkpointing only authorized changes. Review consequential designs before dependent implementation. Do not wait for the user to request a review; honor an explicit request to skip it. Use the default review mode unless the user requests another. Scope implementation reviews to this task's named GitButler branch or explicit base/head, never the combined workspace. State the change's intent and use the review-workflow skill.

BB sends each reviewer's final reply to the parent. Continue other work or yield until those notifications arrive; do not poll. Use scott_engineering_review_result with a reviewer thread ID when you need to retrieve its output. Synthesize agreement and disagreement and classify findings as Act on, Consider, Noted, or Dismissed, with reasons. A review-only request ends with a verdict; apply fixes only when authorized.

Use the existing review conversation for unchanged work. A turn ending, push, PR update, or merge alone does not trigger another review. Findings inform lead judgment; there is no publication-clearance gate.

/review-quick, /review-standard, and /review-deep are user-only shortcuts. Agents use the review tools or bb scott-engineering CLI.
