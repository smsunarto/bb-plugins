---
name: whiteboard
description: Create a Whiteboard for what the user requests, then open it in Whiteboard.
disable-model-invocation: true
---

Create or update a Whiteboard for the user's request and open it in this BB thread.

Before authoring, call `whiteboard_session_get_instructions({topic:"authoring"})` and follow the returned workflow.
