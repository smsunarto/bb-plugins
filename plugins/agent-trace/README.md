# Agent Trace for BB

Agent Trace exports each completed BB thread turn as one OpenTelemetry trace to Laminar, Langfuse, or both. The BB thread ID groups those traces into one session on each backend.

The plugin observes BB's server-side thread event stream. It covers every provider, visible thread, hidden subagent, and background worker without changing an agent CLI or reading provider session files. Provider IDs remain trace attributes for filtering only.

## Configure the plugin

Install the plugin, then set the values for the backends you use in the BB plugin settings. A backend is active when its credentials are set. At least one backend must be configured.

Laminar:

- `laminarApiKey` is the Laminar project API key. BB stores it as a secret setting.
- `laminarEndpoint` is the complete HTTP or HTTPS OTLP URL. It must end in `/v1/traces`. The hosted endpoint is `https://api.lmnr.ai/v1/traces`.

Langfuse:

- `langfusePublicKey` and `langfuseSecretKey` are the project API key pair from Langfuse **Settings → API Keys**. BB stores the secret key as a secret setting.
- `langfuseBaseUrl` is the Langfuse origin. The default is the EU cloud region, `https://cloud.langfuse.com`. Use `https://us.cloud.langfuse.com` for the US region or your self-hosted origin. The plugin posts to `<baseUrl>/api/public/otel/v1/traces` with the `x-langfuse-ingestion-version: 4` header.

Shared:

- `deploymentEnvironment` identifies the source environment on both backends. The default is `development`.
- `contentMode` controls exported content. Choose `full` to populate Input and Output panels. The privacy-safe default is `metadata`.
- `dashboardUrl` optionally embeds a dashboard in the Agent Trace sidebar item. Langfuse Cloud blocks framing, so leave it empty for Langfuse and use the sidebar's "Open Langfuse" link. A self-hosted Laminar embed proxy works here.

Reload the plugin after saving settings. BB clears `needs-configuration` on reload.

## Trace shape

Each trace follows the span layouts both backends document for custom OTLP exporters:

- `bb.agent.turn` is the root span. Laminar sees it as `DEFAULT`; Langfuse sees it as an `agent` observation. It carries the session ID, trace metadata, tags, environment, and the turn's Input and Output.
- `bb.agent.llm` is one span per provider round trip. Laminar sees it as `LLM`; Langfuse sees it as a `generation`. BB does not report model request boundaries, so the plugin infers them from the item stream: a round trip starts when the previous round trip's tools have all finished and ends when its own first tool starts. Reasoning and assistant message items nest under their round trip. In `full` mode the span carries GenAI semantic-convention messages for Laminar and OpenAI-format messages with `tool_calls` for Langfuse.
- Tool items (`commandExecution`, `toolCall`, `fileChange`, and the other tool types) sit directly under the root as `TOOL` spans (Laminar) or `tool` observations (Langfuse), interleaved with the round trips in time order. Web search, web fetch, and search items are `retriever` observations on Langfuse. Delegations are `agent` observations. Background tasks nest under the command that started them.

BB reports token usage once per turn. The plugin attaches that total to the last `bb.agent.llm` span, because both backends only count model spans toward trace tokens and cost. Laminar receives `gen_ai.usage.*` counts. Langfuse receives exclusive usage buckets (`input`, `input_cached_tokens`, `output`, `output_reasoning_tokens`, `total`) as `langfuse.observation.usage_details`. Earlier round trips in the same turn receive zero usage, because Langfuse otherwise estimates tokens for a named model and would double count the turn total. Their `usageScope` metadata says `counted-on-last-step`. `gen_ai.system` maps BB provider IDs to pricing names (`claude-code` to `anthropic`, `codex` to `openai`), and the model name drops BB context suffixes such as `[1m]`. The raw values stay in `bb.provider.id` and `bb.request.model`.

Each backend receives only the attribute families it reads. Laminar-only keys (`lmnr.*`) never reach Langfuse, and Langfuse-only keys (`langfuse.*`) never reach Laminar.

## Self-hosted Laminar dashboard

Laminar blocks framing by default. Start its official Docker Compose stack, then run the scoped embed proxy:

```sh
docker compose -f self-hosted/compose.yml up -d
```

The proxy keeps Laminar's content security policy. It only changes `frame-ancestors` and removes the legacy frame denial header. Local BB URLs are allowed by default. Set `LAMINAR_FRAME_ANCESTORS` to add a remote BB origin before starting the proxy, then set `dashboardUrl` to the proxy URL.

## Content and privacy

`metadata` exports provider, model, session, and trace metadata plus BB thread, turn, request, execution, status, usage, hierarchy, and item attributes. It omits prompts, answers, tool arguments, tool results, command output, file diffs, and extension payloads.

`full` also populates span-level Input and Output with bounded user-visible prompts, assistant answers, tool arguments, and tool results. Automatic visible-thread continuations retain their assistant output without exporting their agent-only prompt. It still excludes reasoning text, reasoning summaries, agent-only input, and hidden-thread content. The plugin reads BB event rows only. It does not open local files or images.

Laminar stores trace output as a hash reference and needs a separate metadata-only span for session-card Input and Output. To repair those fields for Laminar turns exported before `full` mode was enabled, run:

```sh
bb agent-trace backfill --thread <thread-id>
```

The command is Laminar-only and retry-safe on the same BB installation. Langfuse derives trace Input and Output from the root observation and needs no backfill.

## Delivery behavior

The first configured activation records its time. During first discovery, each existing thread records its then-current event head. The plugin does not backfill old turns. It skips a turn already running at activation. Threads created after activation export their first completed turn.

The plugin advances a thread checkpoint only after every configured backend returns an HTTP 2xx response. A failed request keeps the prior checkpoint. A later thread wake, reconnect, or plugin reload retries from that checkpoint with the same deterministic trace and span IDs on every backend. This is retry-safe, but it is not an exactly-once guarantee.

If BB rewrites a thread history, the plugin rebases to the new head and increments `bb.history.revision`. It does not replay the rewritten rows.

## Check a delivered trace

Read a thread's latest turn back from Langfuse and print its observation tree with timing, model, usage, and Input/Output previews:

```sh
bb agent-trace check --thread <thread-id>
```

Add `--raw` for the observations as JSON. The first line is the Langfuse trace URL. The command is Langfuse-only; use the Laminar UI for Laminar traces.

## Status limits

BB reports missing or invalid settings as `needs-configuration`. The plugin log records export failures with the backend name and HTTP status, never a key.
