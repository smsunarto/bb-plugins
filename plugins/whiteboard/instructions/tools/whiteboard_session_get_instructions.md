Load Whiteboard's guide before you create or edit a Whiteboard session. A Whiteboard session is a code walkthrough document that the user reads in a Whiteboard panel tab on the calling bb thread. When the user asks for a Whiteboard or to use Whiteboard (for example to review a branch, a change or a pull request, or to explain a system in Whiteboard), call this first and follow what it returns.

TOPICS

- Omit `topic` (or pass "authoring") for the authoring workflow, document structure and component shapes. Read it before `whiteboard_session_create` or your first `whiteboard_session_edit`.
- "file-lenses": how to group a session's changes into Diff-view lenses with `whiteboard_session_lens_edit`. Point the agent that writes lenses to it.

Returns the guide as Markdown.

RULES FOR EVERY WHITEBOARD TOOL

- Read `whiteboard_session_capabilities` before authoring, and generate software maps only when it reports `softwareMapEnabled: true`.
- `whiteboard_session_create` opens the new session as a tab in the calling thread; call `whiteboard_session_open` only to show an existing session.
- Read and write Whiteboard data only through these tools, never through its files or database.
- Every write takes a `commandId` UUID: a fresh one for each operation, and the same one with identical input when you retry after a lost response.
