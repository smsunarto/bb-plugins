# Cloudflare

Inspect Cloudflare Tunnel and Access resources, and share a development HTTP port from an enrolled BB host behind an email allowlist.

## Setup

Open **Cloudflare → Open settings** in BB. Set the account ID and API token. BB stores the token as a native secret, and the plugin never returns it through UI, RPC, CLI, or agent tools.

For inventory, grant account Tunnel Read and Access Apps and Policies Read. Sharing also needs Tunnel Edit, Access Apps and Policies Edit, Access Identity Providers Read, Access Organizations Read, and zone-scoped Zone Read plus DNS Edit. Choose an existing Zero Trust identity provider. The plugin does not create identity providers or change account-wide authentication.

Install `cloudflared` on each host that will serve a share. The executable defaults to `cloudflared` on that host’s PATH. Set `cloudflaredPath` when another path is needed. Run the development HTTP server on the selected host before creating its share.

## Development shares

Select an enrolled host, DNS zone, unused hostname, localhost port, existing identity provider, and one or more allowed email addresses. Each share owns a dedicated remotely managed tunnel, Access application, reusable allow policy, and proxied CNAME.

The plugin blocks ingress while configuring Access, verifies the allowlist, and requires Access JWT validation at the connector before publishing DNS. A final catch-all returns 404. Existing tunnels, applications, policies, and DNS records remain read-only. Overlapping Access applications and DNS collisions are rejected.

Port and email edits retain the share identity. Removing an email or changing the identity provider blocks ingress, stops the owned connector, updates Access, and revokes existing Access sessions before restarting. Existing connections are not promised instant termination across Cloudflare replicas.

**Running** means Cloudflare reports the tunnel healthy and the selected host reports its child process running. It does not prove an authorized login. Test the public URL in a signed-out browser and complete an allowed-user login before relying on the share.

Stopping blocks ingress first, stops only the plugin’s connector, removes its DNS, and retains Access protection. Removal deletes the owned tunnel and DNS before Access. Offline hosts, active foreign connectors, and changed ownership leave a partial result with confirmed resource IDs. Retry after resolving the reported cause.

A lost creation response is recovered by its durable `bb-dev-<share UUID>` ownership marker. If no unique marker can be found, the plugin refuses another creation attempt. Inspect the named marker in Cloudflare before proceeding. It does not automatically adopt unrelated resources or erase an uncertain operation.

Connector processes belong to the selected host worker. They receive the tunnel token through their environment, and a supervisor terminates and reaps them when the worker disconnects. No operating-system service is installed. Plugin reloads do not automatically republish or restart shares.

## CLI and agents

All surfaces call the same typed server procedures. The agent tool is `cloudflare_shares`, with `overview`, `create`, `update`, `start`, `stop`, and `remove` actions.

```sh
bb cloudflare status
bb cloudflare rpc overview
bb cloudflare rpc create '{"id":"e83fd2ef-b0ae-48e2-9a32-b8707c825d94","hostId":"HOST_ID","zoneId":"ZONE_ID","hostname":"demo.example.com","spec":{"port":3000,"allowedEmails":["you@example.com"],"identityProviderId":"IDP_ID"}}'
bb cloudflare rpc stop '{"id":"e83fd2ef-b0ae-48e2-9a32-b8707c825d94","expectedRevision":1}'
```

Generate a new UUID for each new share and reuse the exact creation input when retrying. Use the current `revision` from overview as `expectedRevision` for update, start, stop, and remove. A stale revision is rejected so a concurrent UI or agent edit cannot silently overwrite another change.

## Development

```sh
bun run typecheck
bun run test
bun run check
bun run build
```

Tests use injected Cloudflare and host dependencies. The production plugin has no fixture mode or configurable API endpoint. Live Cloudflare mutation and Access login verification require a real account token and an enrolled host with a running origin.
