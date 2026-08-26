import { useEffect, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { gtdSidebarRpcContract } from "@/server";
import { WEBHOOK_TUNNEL_CHANNEL } from "@/lib/channels";
import {
  WEBHOOK_TUNNEL_STATUS_OFF,
  type WebhookTunnelStatus,
} from "@/lib/webhook-tunnel-status";

function asStatus(value: unknown): WebhookTunnelStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean" || typeof record.state !== "string") return null;
  return {
    enabled: record.enabled,
    state: record.state as WebhookTunnelStatus["state"],
    url: typeof record.url === "string" ? record.url : null,
    origin: typeof record.origin === "string" ? record.origin : null,
    error: typeof record.error === "string" ? record.error : null,
  };
}

function statusCopy(status: WebhookTunnelStatus, enabled: boolean): string {
  if (!enabled) {
    return "Turn this on to check for cloudflared and open a trycloudflare HTTPS tunnel to a webhook-only local port. GitHub cannot use bb connect URLs, and the bb API port is never exposed.";
  }
  switch (status.state) {
    case "checking":
    case "starting":
      return "Looking for cloudflared and opening a trycloudflare tunnel…";
    case "missing-cloudflared":
      return "cloudflared was not found. Install it with brew install cloudflared, then toggle this setting off and on.";
    case "live":
      return status.url === null
        ? "The trycloudflare tunnel is up. GitHub hooks are registered against it; the address changes when bb restarts."
        : `GitHub can reach this bb at ${status.url}. The address changes when bb restarts.`;
    case "error":
      return status.error ?? "The Cloudflare tunnel failed. Toggle the setting off and on to retry.";
    default:
      return "GitHub webhooks via Cloudflare is on. Waiting for the tunnel to start.";
  }
}

export function GithubWebhookSettings() {
  const { values } = useSettings();
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const connection = useRealtimeConnectionState();
  const enabled = values?.githubWebhooksViaCloudflare === true;
  const [status, setStatus] = useState<WebhookTunnelStatus>(WEBHOOK_TUNNEL_STATUS_OFF);

  useEffect(() => {
    let cancelled = false;
    void rpc
      .call("githubWebhookTunnelStatus", {})
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // The host-rendered toggle still works if status rpc is down.
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, connection, enabled]);

  useRealtime(WEBHOOK_TUNNEL_CHANNEL, (payload) => {
    const next = asStatus(payload);
    if (next !== null) setStatus(next);
  });

  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>{statusCopy(status, enabled)}</p>
      {enabled && status.state === "live" && status.url !== null ? (
        <p>
          <code className="text-foreground">{status.url}</code>
        </p>
      ) : null}
    </div>
  );
}
