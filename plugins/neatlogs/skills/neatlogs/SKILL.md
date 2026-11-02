---
name: neatlogs
description: Configure or diagnose the Neatlogs plugin that exports each completed BB agent turn to Neatlogs as a trace.
---

# Neatlogs

- **Configure:** read [the plugin README](../../README.md) for settings. Set the
  key with `bb plugin config neatlogs set apiKey <key>`; never print, echo, or
  commit the key.
- **Diagnose:** run `bb plugin list` for the plugin's status, then
  `bb plugin logs neatlogs -n 50`. Each export logs its Neatlogs trace ID.
  Warnings name the HTTP status: 401/403/404 means a wrong key or ingest URL
  and holds exports until the settings change; 400/413/422 skips that turn;
  anything else retries after a minute.
- **Verify a turn reached Neatlogs:** match the thread and turn in the log line
  to a trace ID, then read that trace in Neatlogs. A logged export confirms
  ingest acceptance, not how the dashboard renders it.
- Turns completed before the plugin's first activation are never exported;
  absent history is expected, not a failure.
