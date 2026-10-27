Read open feedback across bb pages when the human refers to UI feedback without supplying a self-contained Agentation annotation batch. If a complete batch was supplied, work from it instead of fetching unrelated feedback.

Optionally filter by the owning `pluginId`; use `agentation_get_pending` for one known `sessionId`. Results include pending and acknowledged annotations. Start at the named SDK UI registration in the owning plugin's `app.tsx`, then narrow by selector and React path. Acknowledge each annotation when you pick it up.
