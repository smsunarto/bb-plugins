# Comments and proposed edits

Both files are siblings of the canvas. Keep review metadata out of the MDX so
rendering, source edits, and discussion history remain independent. Agents may
read and write these JSON files directly. The open review panel refreshes every
1.5 seconds. Preserve existing entries when updating a file. Write through a
temporary file and rename it over the sidecar to avoid partially written JSON.
Re-read immediately before writing and merge other writers' changes.

## Comments: `<canvas-path>.comments.json`

```json
{
  "version": 1,
  "threads": [
    {
      "id": "cmt_abcdefghij",
      "anchor": { "quote": "The experiment passed.", "prefix": "", "suffix": "" },
      "resolvedAtMs": null,
      "messages": [
        {
          "id": "message-agent-1",
          "author": "agent",
          "body": "Which run supports this claim?",
          "createdAtMs": 1789000000000
        }
      ]
    }
  ]
}
```

- Thread IDs are `cmt_` plus ten lowercase letters or digits. Message IDs are
  arbitrary nonempty unique strings. Use fresh IDs for new threads and messages.
- `quote` is the exact **rendered text**, without Markdown formatting. It can
  span inline formatting. Optional `prefix` and `suffix` are adjacent rendered
  text. Use them when the quote occurs more than once. No block hash is required.
- The reader highlights an exact, unique match. If context changed but the quote
  is still unique, it follows the quote. Ambiguous or missing text stays in the
  sidebar without guessing a highlight. Legacy block anchors remain readable.
- Append an `author: "agent"` message to respond. Set `resolvedAtMs` to the
  current timestamp to resolve, or `null` to reopen. Preserve the conversation.
- The existing `bb canvas comments` and `bb canvas comment --reply` commands
  remain useful for reading and updating threads with optimistic concurrency.

## Edits: `<canvas-path>.suggestions.json`

```json
{
  "version": 1,
  "proposals": [
    {
      "id": "clarify-experiment",
      "title": "Identify the successful run",
      "author": "agent",
      "createdAtMs": 1789000000000,
      "before": "The experiment passed.",
      "after": "Run 42 passed all 18 checks.",
      "status": "pending"
    }
  ]
}
```

Each proposal is one independent exact replacement in the **MDX source**. IDs
must be unique. Include enough source context for `before` to occur exactly once.
`after` may be empty for deletion. To insert, include an existing nearby passage
in both `before` and `after`. Preserve MDX syntax and frontmatter.

Use separate proposals for edits the user should decide independently. Make
their source ranges disjoint when possible. Accepting an overlapping proposal
may make another stale, which requires refreshing its `before` and `after`.

The panel renders before/after as a unified diff. Named JSON edits were chosen
over a bare patch because each edit also needs an ID, author, title, decision,
and recovery receipt. Application is exact. There is no fuzzy patch matching.

Accept compares the proposal with the reviewed version, matches a unique
passage, and uses the SDK file hash to avoid overwriting concurrent source edits.
Unsaved editor changes must finish saving first. Reject only updates the sidecar.
Accepted and rejected entries remain available under **Show reviewed**.

`applying`, `accepted`, `rejected`, `decidedAtMs`, and `receipt` are managed by the
review UI. Do not alter an applying edit. Its receipt contains the canvas hashes
before and after the change, so **Finish accepting** can recover an interrupted
write without applying twice. If the canvas changed after an interruption, read
the source and receipt before repairing the proposal. Never mark an edit accepted
without verifying that its source change landed.
