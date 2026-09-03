# Laminar for BB

Laminar exports each completed BB thread turn as one OTLP trace. The BB thread ID groups those traces into one Laminar session.

The plugin observes BB's server-side thread event stream. It covers every provider, visible thread, hidden subagent, and background worker without changing an agent CLI or reading provider session files. Provider IDs remain trace attributes for filtering only.

## Configure the plugin

Install the plugin, then set these values in the BB plugin settings:

- `apiKey` is the Laminar project API key. BB stores it as a secret setting.
- `endpoint` is the complete HTTP or HTTPS OTLP URL. It must end in `/v1/traces`.
- `deploymentEnvironment` identifies the source environment in Laminar. The default is `development`.
- `contentMode` controls exported content. Choose `full` to populate Laminar's Input and Output panels. The privacy-safe default is `metadata`.
- `dashboardUrl` opens the self-hosted dashboard from the Laminar sidebar item.

The hosted endpoint is `https://api.lmnr.ai/v1/traces`. A self-hosted endpoint can use any HTTP or HTTPS origin with the same path.

Reload the plugin after saving settings. BB clears `needs-configuration` on reload.

## Self-hosted dashboard

Laminar blocks framing by default. Start its official Docker Compose stack, then run the scoped embed proxy:

```sh
docker compose -f self-hosted/compose.yml up -d
```

The proxy keeps Laminar's content security policy. It only changes `frame-ancestors` and removes the legacy frame denial header. Local BB URLs are allowed by default. Set `LAMINAR_FRAME_ANCESTORS` to add a remote BB origin before starting the proxy.

## Content and privacy

`metadata` exports Laminar-native provider, model, session, and trace metadata. It also exports BB thread, turn, request, execution, status, usage, hierarchy, and item attributes. It omits prompts, answers, tool arguments, tool results, command output, file diffs, and extension payloads.

`full` also populates Laminar's native span and session-card Input and Output fields with bounded user-visible prompts and assistant answers. Automatic visible-thread continuations retain their assistant output without exporting their agent-only prompt. This works without Laminar's optional input-extraction worker. Supported tools include native tool names, arguments, results, and BB item metadata. It still excludes reasoning text, reasoning summaries, agent-only input, and hidden-thread content. The plugin reads BB event rows only. It does not open local files or images.

To repair session-card Input and Output for turns exported before this support was enabled, run:

```sh
bb laminar backfill --thread <thread-id>
```

The command is retry-safe on the same BB installation. It updates Laminar's trace-level fields without duplicating existing spans or token totals. For historical output, it adds one zero-duration content-carrier span per trace because Laminar stores trace output as a hash reference.

## Delivery behavior

The first configured activation records its time. During first discovery, each existing thread records its then-current event head. The plugin does not backfill old turns. It skips a turn already running at activation. Threads created after activation export their first completed turn.

The plugin advances a thread checkpoint only after Laminar returns an HTTP 2xx response. A failed request keeps the prior checkpoint. A later thread wake, reconnect, or plugin reload retries from that checkpoint with the same deterministic trace and span IDs. This is retry-safe, but it is not an exactly-once guarantee.

If BB rewrites a thread history, the plugin rebases to the new head and increments `bb.history.revision`. It does not replay the rewritten rows.

## Status limits

BB reports missing or invalid settings as `needs-configuration`. The plugin log records export failures without the API key. The plugin has no per-trace delivery screen, so use Laminar to check received traces.
