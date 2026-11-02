# Neatlogs

Export every completed BB agent turn to [Neatlogs](https://neatlogs.com) as one
nested trace. It works for every provider BB runs (Claude Code, Codex, and the
rest) because it reads BB's own thread events instead of instrumenting a
provider.

## Setup

Set the project API key from Neatlogs (**Settings → Project → API keys**) in BB
settings, or run:

```sh
bb plugin config neatlogs set apiKey <key>
```

| Setting       | Default                       | Purpose                                                                                                                   |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`      | none                          | Project API key. Stored as a BB secret, never sent to the browser.                                                        |
| `ingestUrl`   | `https://ingest.neatlogs.com` | Ingest origin. Use `https://eu.ingest.neatlogs.com` for EU projects.                                                      |
| `contentMode` | `full`                        | `full` sends prompts, replies, and tool input/output, truncated to 16,000 characters per field. `metadata` sends neither. |

Hidden threads (plugin background workers) always export metadata only.
Metadata mode also omits thread titles, which BB generates from the prompt.

## What a trace contains

- **Root `WORKFLOW` span `bb-agent-turn`:** one per turn, grouped into a
  Neatlogs session by thread ID. Metadata carries the thread, turn, project,
  provider, model, permission mode, and initiator.
- **`LLM` spans:** one per inferred provider round trip. BB does not report
  request boundaries, so a round trip ends when the model's first tool call
  starts. The last one carries the turn's token usage, including cache reads
  and writes. Usage is the change in BB's cumulative usage report since the
  previous turn; a turn exported after BB pruned its report has no usage.
- **`TOOL`, `MCP_TOOL`, `AGENT`, and `TASK` spans:** commands, file edits,
  searches, MCP tool calls, subagents, background tasks, and plan updates. A
  subagent's calls nest under its delegation.

Reasoning text and agent-only prompt parts are never exported.

## Delivery

- The plugin posts each turn to `POST /v1/trace` after BB records
  `turn/completed`, and stores a per-thread checkpoint in plugin storage.
- History from before the plugin's first activation is never exported. A
  fork's inherited turns are not exported again; a turn rerun by a message
  edit is.
- On startup, after a realtime reconnect, and after a settings change, it
  rescans threads changed since activation and exports turns it missed.
- Request bodies are gzipped. Neatlogs's ingest firewall answers an HTML 403
  to uncompressed agent text such as `../` paths, local URLs, and HTML
  attributes, but does not inspect gzip. If it still blocks a turn, the plugin
  resends it without content and marks it `contentWithheld: ingest-firewall`;
  if even that is blocked, it skips the turn.
- HTTP 400/413/422 skips that turn. HTTP 401/404, or a JSON 403, marks the
  plugin _needs configuration_ and holds all exports until the settings change.
  Any other failure retries that thread after a minute.
- Neatlogs assigns trace IDs, so a crash between an accepted POST and the
  checkpoint write can export that turn twice.

`bb plugin logs neatlogs` lists each exported turn with its Neatlogs trace ID.
