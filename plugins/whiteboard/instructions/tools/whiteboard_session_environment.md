Check whether the registered checkout behind a Whiteboard session's worktree target can still be read from its bb host. Use it when reads of a worktree session fail and you need to know whether the checkout itself is missing or unreadable.

Returns `issues`: empty when the checkout is readable, otherwise one head-side entry describing the problem. Whiteboard in bb prepares no checkouts of its own, so sessions with a commits target and the scratchpad always return no issues, and `retry` has no effect.
