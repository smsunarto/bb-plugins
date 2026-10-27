Wait for feedback activity, then return open annotations created or changed since this call began. Changes to existing annotations, including replies and status updates, can appear in the batch. Use `agentation_get_all_pending` or `agentation_get_pending` to read all feedback already open when you start.

Optionally restrict the watch to one `sessionId`. `timeoutSeconds` bounds the wait for new annotations; `batchWindowSeconds` collects additional annotations after the first arrives. A timeout returns a notice rather than a batch; call again to keep waiting.

For hands-free feedback, repeat: watch, inspect each annotation's status, acknowledge the work you take on, fix, resolve, then watch again. Leave work already acknowledged by another thread with that thread.
