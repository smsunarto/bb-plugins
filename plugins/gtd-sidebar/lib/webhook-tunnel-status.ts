export type WebhookTunnelState =
  | "off"
  | "checking"
  | "missing-cloudflared"
  | "starting"
  | "live"
  | "error";

export interface WebhookTunnelStatus {
  enabled: boolean;
  state: WebhookTunnelState;
  url: string | null;
  origin: string | null;
  error: string | null;
}

export const WEBHOOK_TUNNEL_STATUS_OFF: WebhookTunnelStatus = {
  enabled: false,
  state: "off",
  url: null,
  origin: null,
  error: null,
};
