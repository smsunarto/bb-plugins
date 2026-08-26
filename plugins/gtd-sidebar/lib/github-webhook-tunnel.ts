import {
  dedicatedGithubWebhookUrl,
  shouldStartCloudflareTunnel,
} from "./github-webhook.ts";
import {
  resolveCloudflaredPath,
  startTrycloudflareTunnel,
  type TrycloudflareTunnel,
} from "./cloudflared.ts";
import {
  startWebhookListener,
  type WebhookRequestHandler,
} from "./webhook-listener.ts";
import type { WebhookTunnelStatus } from "./webhook-tunnel-status.ts";

export type { WebhookTunnelStatus, WebhookTunnelState } from "./webhook-tunnel-status.ts";
export { WEBHOOK_TUNNEL_STATUS_OFF } from "./webhook-tunnel-status.ts";

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitUntilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export async function maintainCloudflareWebhookTunnel(args: {
  signal: AbortSignal;
  readSettings: () => Promise<{ enabled: boolean; configuredOrigin: string }>;
  onSettingsChange: (listener: () => void) => () => void;
  handle: WebhookRequestHandler;
  onLive: (info: { origin: string; url: string }) => void;
  onStopped: () => void;
  onStatus: (status: WebhookTunnelStatus) => void;
  log: { info(message: string): void; warn(message: string): void };
  resolveBin?: typeof resolveCloudflaredPath;
  startListener?: typeof startWebhookListener;
  startTunnel?: typeof startTrycloudflareTunnel;
  retryDelayMs?: number;
}): Promise<void> {
  const resolveBin = args.resolveBin ?? resolveCloudflaredPath;
  const startListener = args.startListener ?? startWebhookListener;
  const startTunnel = args.startTunnel ?? startTrycloudflareTunnel;
  const retryDelayMs = args.retryDelayMs ?? 5_000;

  let settingsWaiters: Array<() => void> = [];
  let activeRun: AbortController | null = null;
  const unsubscribe = args.onSettingsChange(() => {
    const waiters = settingsWaiters;
    settingsWaiters = [];
    for (const wake of waiters) wake();
    void args.readSettings().then((next) => {
      if (!shouldStartCloudflareTunnel(next.enabled, next.configuredOrigin)) {
        activeRun?.abort();
      }
    });
  });
  const waitForSettings = () =>
    new Promise<void>((resolve) => {
      if (args.signal.aborted) {
        resolve();
        return;
      }
      const onAbort = () => {
        args.signal.removeEventListener("abort", onAbort);
        resolve();
      };
      args.signal.addEventListener("abort", onAbort, { once: true });
      settingsWaiters.push(() => {
        args.signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });

  try {
    while (!args.signal.aborted) {
      const settings = await args.readSettings();
      if (!shouldStartCloudflareTunnel(settings.enabled, settings.configuredOrigin)) {
        args.onStopped();
        args.onStatus({
          enabled: settings.enabled,
          state: "off",
          url: null,
          origin: null,
          error: null,
        });
        await waitForSettings();
        continue;
      }

      args.onStatus({
        enabled: true,
        state: "checking",
        url: null,
        origin: null,
        error: null,
      });
      const bin = await resolveBin(args.signal);
      if (args.signal.aborted) return;
      if (bin === null) {
        args.log.warn(
          "github webhooks: cloudflared not found. Install it with `brew install cloudflared`, then toggle the setting off and on.",
        );
        args.onStatus({
          enabled: true,
          state: "missing-cloudflared",
          url: null,
          origin: null,
          error: "cloudflared not found on PATH",
        });
        await waitForSettings();
        continue;
      }

      const run = new AbortController();
      activeRun = run;
      const stopRun = () => run.abort();
      args.signal.addEventListener("abort", stopRun);

      let listener: { port: number; close: () => Promise<void> } | null = null;
      let tunnel: TrycloudflareTunnel | null = null;
      try {
        args.onStatus({
          enabled: true,
          state: "starting",
          url: null,
          origin: null,
          error: null,
        });
        listener = await startListener({ handle: args.handle, signal: run.signal });
        tunnel = await startTunnel({
          bin,
          localOrigin: `http://127.0.0.1:${listener.port}`,
          signal: run.signal,
        });
        const url = dedicatedGithubWebhookUrl(tunnel.origin);
        args.onLive({ origin: tunnel.origin, url });
        args.onStatus({
          enabled: true,
          state: "live",
          url,
          origin: tunnel.origin,
          error: null,
        });
        args.log.info(`github webhooks: trycloudflare ${url}`);
        await Promise.race([tunnel.wait, waitUntilAborted(run.signal)]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!run.signal.aborted && !args.signal.aborted) {
          args.log.warn(`github webhook tunnel: ${message}`);
          args.onStatus({
            enabled: true,
            state: "error",
            url: null,
            origin: null,
            error: message,
          });
          await sleep(retryDelayMs, args.signal);
        }
      } finally {
        args.signal.removeEventListener("abort", stopRun);
        if (activeRun === run) activeRun = null;
        args.onStopped();
        tunnel?.stop();
        if (listener !== null) {
          try {
            await listener.close();
          } catch {
            // Listener already closed on abort.
          }
        }
      }
    }
  } finally {
    unsubscribe();
  }
}
