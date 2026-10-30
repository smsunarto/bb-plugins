Check what Whiteboard can do for this call before you author a session or draw on the scratchpad. Returns `desktopAvailable` (true when called from a bb thread, so sessions can open there as panel tabs), `softwareMapEnabled` (the Software Map setting), and `scratchpadEnabled` (the Scratchpad setting).

Generate software maps only when `softwareMapEnabled` is true. Uploading an existing map with `whiteboard_session_upload` works either way.
