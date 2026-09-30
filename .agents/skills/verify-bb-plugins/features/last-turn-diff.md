# Last Turn Diff

## Fixture and entry

Open a repository-backed thread with a completed turn that has a final assistant
response and recorded file edits. Use a controlled fixture with a known patch.
The preview sits immediately after that turn's final assistant response.

## Driving and proof

1. Wait for **Last turn**. Verify its file count and added/removed counts against
   the recorded patch.
2. Expand a file and check that its unified diff contains the expected change.
   For Unity assets, verify named objects, components, and Before/After values.
   Toggle Raw YAML and Object view, then collapse and reopen the file.
   A workspace file that no longer matches the recorded patch must keep its raw diff.
   Exercise **Expand all** and **Collapse all** with a fixture containing several files.
3. Complete a later turn without file edits. The previous preview must remain under its original response.
   A later turn with edits must replace it with that turn's changes.

Take a snapshot before choosing file controls. Capture the collapsed card,
expanded diff, and the later turn's replacement or retention. Save the thread URL.

## Gotchas

- Git checkouts get workspace snapshots, so a shell-only edit made during the
  turn appears. Non-Git environments still need a recorded aggregate patch or
  file-change event.
- Snapshots start with the first turn dispatched after the plugin loads. Older
  turns fall back to recorded edits.
- The old preview remains while a new turn is running. Assert replacement after
  completion, not at turn start.
- Missing final assistant rows prevent the preview from mounting. A never-run
  draft thread is not a suitable fixture.
- This is a read-only preview. Do not invoke Git mutation controls to test it.

Source entries: `plugins/last-turn-diff/src/app/app.tsx` and
`plugins/last-turn-diff/src/server/rpc/latest-turn.ts`.
