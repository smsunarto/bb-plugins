List Whiteboard sessions, to find the `sessionId` of a Whiteboard the user mentions. Each row carries `sessionId`, `title`, `version`, `source` (the target and its resolved pins), `origin` (PR and branch), `repositoryName`, `repositoryPath`, `lenses`, `viewedAt` and `dismissedAt`. Rows carry no document content; read a session with `whiteboard_session_get`. The calling thread's scratchpad is listed (`kind: "scratchpad"`) while the Scratchpad setting is on.

For a pull request you do not need to search: `whiteboard_session_create` with source "pull-request" returns the PR's existing session.
