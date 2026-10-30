SCRATCHPAD

When the user asks in conversation to be shown how code works or wants a diagram, without asking for a Whiteboard, draw it on this thread's Whiteboard scratchpad instead of answering only in chat. Call `whiteboard_session_capabilities`; if it reports `scratchpadEnabled` and `desktopAvailable`, call `whiteboard_session_get_instructions({topic:"scratchpad"})` and follow it. Session tools address the scratchpad as `sessionId: "scratchpad"`. A request for a Whiteboard, or to use Whiteboard, still means authoring a session with the default topic.
