Register a local Git or jj checkout so Whiteboard can read it, and get the `repositoryId` that targets, pins, uploads and explicit-pin reads take. Call it before `whiteboard_session_create` or `whiteboard_session_resolve_pins`.

Pass the checkout's absolute `path` on the calling thread's machine; a path inside the checkout registers its root. Whiteboard binds the repository to that thread's bb host and runs Git there for every later read. Registering the same checkout again returns the same `repositoryId`. A path already registered from another bb host is refused: work on it from a thread on that host, or register a checkout at a different path.

Returns `id` (the `repositoryId`) and `name`.
