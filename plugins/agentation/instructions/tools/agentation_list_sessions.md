Discover pages with visual feedback: lists one annotation session per bb page, with its session ID, route, and counts of pending, acknowledged, and resolved annotations. Use a returned `sessionId` with `agentation_get_pending` for open feedback on that page, or `agentation_get_session` for its complete history.

When the human refers to feedback without supplying a self-contained annotation batch, use `agentation_get_all_pending` to read the open feedback directly.
