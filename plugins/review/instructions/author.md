Use review_start for independent design or implementation review when useful. Modes select reasoning effort: quick (medium), standard (high), deep (max). Supply a short summary and the intended target; optional brief and evidence add context. Read the review-workflow skill for target and reuse details.

Review the publication candidate once with Deep implementation scope:publication and resolve blocking findings. Reuse that run at push, PR update, and merge while the candidate is unchanged; those actions alone do not trigger another review. Descendant PR helpers can use the same assessment. Reassess when the candidate changes.

BB notifies the parent when the reviewer completes or fails. Continue independent work or yield; do not poll. On notification, or immediately for an already-completed run, call review_result with that run ID and waitSeconds:0 to validate the result before relying on it.

/review-quick, /review-standard, and /review-deep are user-only commands. Agents use the review tools or bb review CLI.
