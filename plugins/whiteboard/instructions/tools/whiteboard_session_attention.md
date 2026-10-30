Change how a Whiteboard session appears on Whiteboard Home, without changing its content or creating a version. `action` "dismiss" moves it to the dismissed group, "restore" brings it back, and "view" records that the user has seen it (`viewedAt`). Use it when the user asks to dismiss, restore or mark a session as viewed. The scratchpad cannot be dismissed or marked.

Pass a fresh UUID `commandId`; no lease is needed. After a lost response, retry with the same `commandId` and identical input.
