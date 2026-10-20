# Example issue

A bug report in the house style, carrying all seven headings. Note what it does: opens with
how it was hit, quotes the source rather than describing it, proposes once, marks the
unverified part, and names prior art in a single sentence.

---

**Title:** `fix(connect): tunnel dial that hangs before the handshake permanently stops the reconnect loop`

## Refs

- https://github.com/openai/codex/blob/main/codex-rs/app-server-transport/src/transport/remote_control/websocket.rs

## What happens

Found after leaving this Mac asleep overnight. All three of my remote machines showed `disconnected` and stayed that way for 13.5 hours, about 2 of those with the machine awake and the network fine. `bb connect status` said `reconnecting` the entire time. It wasn't. `bb plugin reload connect` brought it back in 0.238s.

## Why

The tunnel socket is dialed with no connect timeout, and the next retry is only ever scheduled from that socket's `close` handler:

```ts
// packages/bb-plugin-connect/src/tunnel.ts, openTunnel()
tunnel = new NodeWebSocket(tunnelUrl, {
  headers: { authorization: `Bearer ${credential.credential}` },
});

tunnel.on("open",  ...);                // clears error state
tunnel.on("error", ...);                // sets lastError only
tunnel.on("close", (code, reason) => {
  const delay = this.backoff.nextDelayAfterClose(stable);
  this.reconnectTimer = setTimeout(() => this.openTunnel(), delay);  // the only scheduler
});
```

So when a dial stalls instead of failing — which is what a black-holed route after sleep gives you — there's no `open`, no `error`, no `close`, nothing schedules the next attempt, and the loop is simply over. The heartbeat can't cover it either, since `TunnelSession` is constructed inside the `open` handler and only ever supervises a socket that already connected. That's why every earlier drop in my log recovered fine and this one didn't: sleep dropping the tunnel is expected, a dial that hangs before the handshake is not.

## Proposal

`handshakeTimeout` is never set anywhere in the plugin. Grepping the shipped bundle turns up exactly one hit, inside vendored `ws` itself. We should set it:

```diff
 tunnel = new NodeWebSocket(tunnelUrl, {
   headers: { authorization: `Bearer ${credential.credential}` },
+  handshakeTimeout: TUNNEL_HANDSHAKE_TIMEOUT_MS,
 });
```

That alone fixes what I hit — it turns the stall into `error` + `close`, which the existing scheduler already handles. Codex carries the same shape of thing (a long-lived client-dialed control socket that has to survive sleep unattended) and wraps its dial in `tokio::time::timeout(REMOTE_CONTROL_WEBSOCKET_CONNECT_TIMEOUT, connect_async(request))` for exactly this case.

Other things I noticed while digging, all optional, roughly in the order I'd care about them:

- The backoff can't come back down off its cap. `nextDelayAfterClose` in `packages/tunnel-client/src/reconnect.ts` only resets `attempt` after a connection that stayed open >10s, so while dialing keeps failing `stableMs` is always 0 and the delay pins at 30s. Codex's `next_reconnect_delay` sets `attempt = 0` on reaching the cap. One sleep window swallows the whole 1+2+4+8+16s ladder, so you land on the cap nearly every time.
- Retries probably shouldn't hang off `close` at all. A watchdog armed alongside each dial would get most of the benefit without restructuring.
- No jitter on the delay, so every client behind one relay retries in lockstep.

## Evidence

Machine continuously awake since 12:31:41 (last `Entering Sleep` 12:27:10):

```
12:49:11 -> closed  30.003s
12:50:11 -> closed  30.005s
13:02:39 -> (nothing)
```

Silence after that until I reloaded the plugin ~2h later. The remote daemons were retrying correctly throughout, failing with `Failed to open session: 503 Service Unavailable`, and all three reported `disconnected` with `lastSeenAt` identical to the millisecond.

Status is misleading once this happens. `lastError` is only cleared in `open` and `nextRetryAt` is only assigned in `close`, so when the loop dies both go stale. Mine read `can't reach getbb.app — host not found`, set during a sleep window when DNS genuinely was down, still on screen hours later while `curl` to both the apex and my handle returned in under 100ms. I chased DNS for a while because of it.

## Reproduction

I haven't reproduced it deliberately — sleep is a flaky trigger — but a black-holed route should hit it directly. Packets have to be _dropped_, not rejected; an RST produces a `close` and the loop survives.

1. Pair connect, confirm `connected`.
2. `dig +short <handle>.getbb.app`, then add `block drop out quick to <addr> port 443` to `pf`.
3. Wait for the drop and for the backoff to fire a redial while the rule is live. That dial should hang with no `close` logged.
4. Remove the rule. Nothing should bring the loop back.

## Environment

bb-app 0.38.0 desktop, bb-plugin-connect 0.1.0, bundled `ws@8.21.0`, macOS 26.5.2 arm64, 3 remote machines. No repo checkout so no commit SHA — the source above is out of the `sourcesContent` in the shipped `builtin-plugins/connect/dist/server.js.map`.
