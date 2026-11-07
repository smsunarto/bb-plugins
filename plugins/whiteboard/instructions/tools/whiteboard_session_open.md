Add an existing Whiteboard session as a tab in the calling bb thread. Use it when the user wants to see a session that is not open; `whiteboard_session_create` already opens the sessions it creates. It works only when called from a bb thread. The tab does not come to the front: tell the user to click **Open Whiteboard** in the thread header to see it.

Returns `ok` and `softwareMapEnabled`. Opening changes only what the user sees: it saves no version and needs no lease or `commandId`.
