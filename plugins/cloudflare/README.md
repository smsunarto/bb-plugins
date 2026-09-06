# Cloudflare

Inspect Cloudflare DNS, Tunnel, and Access resources, and share a development HTTP port from an enrolled BB host behind an email allowlist.

## Setup

The plugin connects through Cloudflare OAuth with Authorization Code and PKCE. Once the OAuth client is configured, open **Cloudflare** in BB and select **Connect with Cloudflare**. Approve the requested account and zone access. Cloudflare returns you to BB when sign-in completes.

BB keeps the OAuth access and refresh tokens in its native, file-based secret storage on the server, with file permissions restricted to the owner (`0600`). The plugin refreshes access automatically and never returns tokens through UI, RPC, CLI, or agent tools. Select **Disconnect** to remove this connection. Existing shares keep running, and reconnecting restores their management controls.

### Register the OAuth client

Create a [private Cloudflare OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) in the account you want to connect. Select the `code` response type, both **Authorization Code** and **Refresh Token** grant types, and `none` for token endpoint authentication. The plugin uses PKCE with S256, so no client secret is needed.

Register this exact callback URI, replacing the origin with the HTTPS address of your BB server:

```text
https://your-bb.example/api/v1/plugins/cloudflare/http/oauth/callback
```

Press Enter after pasting the callback into Cloudflare's redirect URI field so it is added to the list.

Register permissions for Cloudflare One Connectors Read/Edit, Access Apps and Policies Read/Edit/Revoke, Access Identity Providers Read, Access Organizations Read, Zone Read, and DNS Read/Edit.

Open **Cloudflare → Open settings** in BB and save the account ID, OAuth client ID (`oauthClientId`), and the same callback URI (`oauthRedirectUri`). Copy the exact OAuth scope IDs from your registered client into **OAuth permissions** (`oauthScopes`), separated by spaces. Use OAuth scope IDs rather than permission display names or API token permission UUIDs. Find the IDs in your registration or Cloudflare's [authenticated OAuth scope catalogue](https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/). The plugin automatically adds `offline_access` so BB can renew the connection.

All four settings are required before connecting. A private client can connect members of its owning Cloudflare account.

Choose an existing Zero Trust identity provider when creating a share. The plugin does not create identity providers or change account-wide authentication.

Install `cloudflared` on each host that will serve a share. The executable defaults to `cloudflared` on that host’s PATH. Set `cloudflaredPath` when another path is needed. Run the development HTTP server on the selected host before creating its share.

## DNS and tunnel links

The **DNS** tab lists records across the connected account's zones. Filter by zone or record type, or search record names, types, and values. Expand a row to see IDs and TTL. Records that point directly to an account tunnel show that tunnel's name. A failed zone lookup leaves records from other zones visible with an error.

The **Tunnels** tab shows public hostnames found in DNS records and remotely managed ingress configuration. Open or copy an available HTTPS link. Hostnames found only in ingress are labeled separately because their DNS may still need configuration. Wildcards and non-HTTP routes are shown as text. Configured links do not establish application reachability or successful Access login.

Every named tunnel also shows its Cloudflare-generated `<tunnel-id>.cfargotunnel.com` DNS target for copying. This is a CNAME routing target, not a public website URL. [Cloudflare's routing documentation](https://developers.cloudflare.com/tunnel/routing/) explains the relationship.

[Quick Tunnels](https://developers.cloudflare.com/tunnel/setup/#quick-tunnels-development) generate temporary `trycloudflare.com` links in the connector's terminal. They are independent of the connected account inventory. This plugin manages named tunnels and does not discover Quick Tunnel processes or generate substitute links for them.

## Manage existing tunnels

Select **Manage** on a tunnel card to inspect connectors, rename the tunnel, or edit its ordered public ingress routes. Connector details include cloudflared version, architecture, start time, applied configuration version, and observed connections. Missing metadata is shown as unavailable. This does not restart or stop a connector.

Name and route changes have separate save buttons. Add, edit, remove, or move named routes, then save the route layout in one operation. The final catch-all is read-only. Advanced configuration stays on the server and is preserved, including unknown settings, origin overrides, unchanged paths, and private origin URLs. Private origins appear as a label and remain unchanged unless explicitly replaced. New or replaced origins cannot contain embedded credentials, query parameters, fragments, or URL paths.

Locally configured tunnels support rename and connector details, but their routes must be changed in the connector configuration. Unsupported ingress layouts are also read-only. Tunnels recorded by development shares remain under the share controls, including partial or removed share records.

Drafts survive tab changes and polling for the same account, OAuth client, and tunnel. Changing the connection binding clears them. Each route save checks a revision covering the full current configuration, including hidden settings. A stale result retains the draft and requires an explicit discard and reload before another save. An unconfirmed write offers **Refresh status** and keeps both saves locked. Refreshing or reopening the editor cannot bypass a pending write.

Before each write, the plugin stores a durable pending record with the target and a hash of the intended name or configuration. The record contains no raw configuration, private origins, or plaintext tunnel name. It survives server restarts and blocks later writes to the same account tunnel, including from another tab or OAuth client. The plugin clears it after a definite rejection or after observing the intended result. Storage failures keep writes blocked. A pending record does not expire automatically. If Cloudflare never shows the intended result, the plugin cannot safely assume that a delayed request will never apply.

The plugin sends one write and reads the result back. It does not retry or roll back an uncertain write. Once status refresh confirms the pending result, explicitly discard and reload the old draft before saving again. Cloudflare does not document a compare-and-swap operation for tunnel configuration. The plugin serializes its own edits and detects changes made before its last read, but an external edit can still race the write. Confirmation describes the state observed during readback.

Saving routes changes public ingress only. It does not create DNS records or change Access protection. Configure those separately before relying on a new hostname. Tunnel deletion, credential rotation, connector termination, and host process control are outside these controls.

## Development shares

Select an enrolled host, DNS zone, unused hostname, localhost port, existing identity provider, and one or more allowed email addresses. Each share owns a dedicated remotely managed tunnel, Access application, reusable allow policy, and proxied CNAME.

The plugin blocks ingress while configuring Access, verifies the allowlist, and requires Access JWT validation at the connector before publishing DNS. A final catch-all returns 404. Existing applications, policies, and DNS records remain read-only. Account tunnels have separate management controls described above. Overlapping Access applications and DNS collisions are rejected.

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

Tests use injected Cloudflare and host dependencies. The production plugin has no fixture mode or configurable API endpoint. Live Cloudflare mutation and Access login verification require a connected Cloudflare account and an enrolled host with a running origin.
