# Notify

- RPC map keys and the `notify_user` tool name are a public contract. Do not rename them.
- Keep renderer routes, thread events, settings, and command copy in lockstep with `app/app.tsx`.
- Delivery is ephemeral. Do not add a durable queue, replay, or an `osascript` fallback.
