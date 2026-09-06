# Traces

A local trace explorer for **Claude Code and Codex**. Open Traces in BB's sidebar, or open the Traces tab in a thread's side panel.

The session list, timeline, and inspector keep navigation quick. Filter by provider, event kind, or evidence topic. Select an event for a formatted view of messages, commands, edits, patches, searches, MCP calls, subagent tasks, and context. Raw shows the original JSONL record, including whitespace and fields the adapter does not recognize.

## Evidence

- **Instructions:** captured AGENTS.md, CLAUDE.md, developer instructions, and policy content. References are labeled separately. The viewer never substitutes today's file contents for what the trace recorded.
- **Skills and plugins:** available, requested, loaded, and invoked are separate evidence states. A listing does not prove use. Recorded attribution and successful skill reads carry their source pointers.
- **Sandbox:** recorded blocks, bypass requests, and enabled bypass policy remain distinct. An escalation request does not establish approval. Generic command failures do not establish sandbox denial.
- **Subagents, MCP, and search:** tool activity, identifiers, and captured results. Native search and Parallel activity have separate labels. A mention of a search tool or skill does not count as a search call.

Inferred evidence is labeled. Missing or encrypted provider content cannot be reconstructed. Unsupported records remain inspectable through the generic template and raw record.

## Sources and performance

Choose a BB host, then use **Sources** to configure folders or JSONL files on that host. Defaults honor `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, including Codex archived sessions. Source files are read-only. The host owns a SQLite index in its plugin data directory. The BB server only routes validated requests.

Disabling a source retains its cached traces. Removing it deletes its derived index entries, without deleting source files.

Search covers session metadata and bounded event summaries, tool names, and evidence labels. It is not a full-text search of every raw payload. Lists contain at most 50 sessions or 100 events per page. Bodies load only for the selected event. Large raw records are paged in overlapping chunks that preserve UTF-8 characters.

The scanner resumes at complete-line byte offsets and leaves partial trailing lines for the next append. Malformed and oversized records have diagnostic entries with raw access. Rebuilds publish a completed generation. Normal append checks use file metadata and fixed probes. **Verify sources** checks every indexed record, and periodic reconciliation performs the same audit. Interior rewrites outside the probes can remain indexed until that audit. Raw reads validate source integrity and report changed or missing files instead of silently displaying another record.

## Keyboard

| Key               | Action                                      |
| ----------------- | ------------------------------------------- |
| `j` / `k`, arrows | Move through the focused list               |
| `Home` / `End`    | First or last item on the page              |
| `Enter`           | Move from sessions to timeline to inspector |
| `Esc`             | Move back one pane                          |
| `/`               | Search the current session                  |
| `r`               | Toggle formatted and raw                    |
| `?`               | Show shortcuts                              |

Typing in an input does not trigger these shortcuts. Refresh preserves the selected event. A selection outside the current page or filter is labeled.

## Extension points

`TraceAdapter` in `src/shared/model.ts` is a pure record-to-events contract. Each event has a template ID, typed body, evidence with source pointers, and provenance. Register adapters through `createTraceHost({ adapters: [...builtinAdapters, customAdapter] })` in the host entry. Only the two built-ins ship by default. Increment an adapter's version when its stored interpretation changes.

Register display templates with `createTraceRendererRegistry([{ template, component }])`, then pass the registry to `createTracesApp({ renderers })` in the app entry. Custom registrations can replace built-in templates. Unknown template IDs use the generic renderer. Providers and renderers do not import each other.

The package exports `./model`, `./adapters`, `./renderers`, `./host`, and `./app` for these contracts and factories.

## Machine-readable access

bb-kit exposes the same validated RPCs through `bb traces rpc <name> '<JSON object>'`. `overview` lists hosts and can resolve a BB thread to its provider session. `status`, `sessions`, `events`, `event`, and `raw` read a selected `hostId`. `scan` and `configureSources` manage the derived index.

Responses carry `schemaVersion: 1`. Session and event queries use opaque cursors. Events include stable IDs, provider/native IDs, source line, JSON pointer, byte range, record hash, and adapter version. `raw` accepts an event ID, byte offset, and bounded limit, returning exact bytes as base64. This read surface supports later analysis tools. Automatic trace analysis is not included.

## Development

Run the repository dev loop before editing. Run this package's tests under Node 22 or later, then verify through the pinned BB development instance. The index uses Node's built-in SQLite, so the host bundle needs no native addon installation.
