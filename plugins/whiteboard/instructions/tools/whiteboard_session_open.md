Show an existing Whiteboard session to the user as a tab in the calling bb thread. Use it when the user wants to see a session that is not open; `whiteboard_session_create` already opens the sessions it creates. It works only when called from a bb thread.

Returns `ok` and `softwareMapEnabled`. Opening changes only what the user sees: it saves no version and needs no lease or `commandId`.
