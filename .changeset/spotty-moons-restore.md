---
"@smsunarto/bb-plugin-amp": minor
---

Give the Amp thread back when bb unarchives. Archiving a bb thread archived its
Amp thread, and nothing reversed it.

The restore cannot be received: bb 0.38 emits six plugin thread events —
`created`, `active`, `idle`, `failed`, `archived`, `deleted` — and unarchive is
not one. So the archive half stays event-driven and the restore half is polled.
`thread.archived` writes an `amp-archive-watch:<id>` row naming the Amp thread
it took, and a background service asks bb every 20 seconds which of those bb
still calls archived. Reading the state covers t3sidebar and bb's own view at
once, rather than the action either one performs.

The listing is one paginated query however many rows are watched, and the pass
exits before it when there are none. It only suggests a restore — it is capped
and drops deleted threads — so each candidate is confirmed against the thread
itself first. Amp has no `threads unarchive`; the restore is `threads archive
<id> --unarchive`, one flag from the archive path. A candidate that fails three
times, an Amp thread deleted on Amp's side being that case, is dropped rather
than retried forever.

Threads archived before this upgrade carry no watch row and are not restored.
