import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginKvStorage } from "@get-bb/plugin-sdk";
import { CloudflareOAuth, oauthCallbackResponse } from "./oauth.ts";
import { readNetworkInventory, tunnelDNSTarget } from "./inventory.ts";
import { z } from "zod";
import { cloudflareHostContract } from "../../shared/host-contract.ts";
import {
  shareSchema,
  tunnelTargetSchema,
  type TunnelWriteState,
  type TunnelTarget,
  type TunnelDetails,
  type EditTunnel,
  type TunnelWriteResult,
  type CreateShare,
  type Spec,
  type Share,
  type ShareResult,
  type Overview,
} from "../../shared/schema.ts";
import {
  CloudflareAPI,
  CloudflareError,
  tunnelSchema,
  connectionSchema,
  connectorResponseSchema,
  policySchema,
  appSchema,
  dnsSchema,
  zoneSchema,
  idpSchema,
  configSchema,
  appOverlaps,
  policyEmails,
} from "./api.ts";

import {
  TunnelDraftError,
  connectorView,
  configurationFingerprint,
  applyRouteDraft,
  editableConfiguration,
  inspectConfiguration,
  sameConfiguration,
} from "./tunnels.ts";

class TunnelBlocked extends Error {
  readonly reason: "stale" | "ownership" | "source" | "connection";
  constructor(reason: "stale" | "ownership" | "source" | "connection", message: string) {
    super(message);
    this.reason = reason;
  }
}

function tunnelPreparationFailure(error: unknown): TunnelWriteResult {
  if (error instanceof TunnelBlocked)
    return { kind: "blocked", reason: error.reason, message: error.message };
  if (error instanceof TunnelDraftError) return { kind: "rejected", message: error.message };
  return {
    kind: "rejected",
    message:
      error instanceof CloudflareError && !error.uncertain && error.status !== 0
        ? error.message
        : "The request could not be prepared. No change was sent. Check the route fields, permissions, and connection.",
  };
}

const tunnelWriteFenceSchema = z
  .object({
    operationId: z.uuid().optional(),
    target: tunnelTargetSchema,
    intent: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("rename"), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict(),
      z
        .object({ kind: z.literal("routes"), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict(),
    ]),
  })
  .strict();
type TunnelWriteIntent = z.infer<typeof tunnelWriteFenceSchema>["intent"];
const tunnelWriteKey = (target: TunnelTarget) =>
  `tunnel-write:${target.accountId}:${target.tunnelId}`;
const pendingTunnelWrite: Extract<TunnelWriteState, { kind: "unconfirmed" }> = {
  kind: "unconfirmed",
  message:
    "An earlier tunnel write is still unconfirmed. Further writes remain blocked. Refresh status, or explicitly recover editing after reviewing the risk of a delayed write.",
};
const unavailableTunnelWrite: Extract<TunnelWriteState, { kind: "unconfirmed" }> = {
  kind: "unconfirmed",
  message:
    "Tunnel write status could not be safely recorded or checked. Further writes are blocked. Refresh status after storage and Cloudflare connectivity recover.",
};

const recordSchema = shareSchema.extend({
  config: z.record(z.string(), z.unknown()).optional(),
  pendingConfig: z.record(z.string(), z.unknown()).optional(),
  policySnapshot: z.record(z.string(), z.unknown()).optional(),
  pendingPolicy: z.record(z.string(), z.unknown()).optional(),
  appSnapshot: z.record(z.string(), z.unknown()).optional(),
  pendingApp: z.record(z.string(), z.unknown()).optional(),
  policyCreateIntent: z.record(z.string(), z.unknown()).optional(),
  appCreateIntent: z.record(z.string(), z.unknown()).optional(),
});
type RecordShare = z.infer<typeof recordSchema>;
type Settings = { accountId?: string; cloudflaredPath: string };
type HostStatus = { running: boolean; connectorId?: string };
export interface Dependencies {
  storage: PluginKvStorage;
  settings: () => Promise<Settings>;
  oauth: Pick<CloudflareOAuth, "status" | "credentials">;
  api: (token: string) => CloudflareAPI;
  hosts: () => Promise<{ id: string; name: string; online: boolean }[]>;
  probe: (
    hostId: string,
    port: number,
    executable: string,
  ) => Promise<{ available: boolean; originReachable: boolean; message: string }>;
  status: (hostId: string, id: string) => Promise<HostStatus>;
  start: (hostId: string, id: string, token: string, executable: string) => Promise<HostStatus>;
  stop: (hostId: string, id: string) => Promise<HostStatus>;
}
const permissions = [
  "Account: Cloudflare Tunnel Read/Edit",
  "Account: Access Apps and Policies Read/Edit",
  "Account: Access Identity Providers Read",
  "Account: Access Organizations Read",
  "Zone: Zone Read and DNS Read/Edit",
];
const blocked = { ingress: [{ service: "http_status:404" }] };
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const name = (s: Share) => `bb-dev-${s.id}`;
const fail = (message: string): never => {
  throw new CloudflareError(message);
};
const securityShape = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => !["created_at", "updated_at", "app_count"].includes(key),
    ),
  );
const matchesIntent = (actual: Record<string, unknown>, intent: Record<string, unknown>) =>
  Object.entries(intent).every(([key, value]) =>
    key === "policies"
      ? same(
          (actual.policies as { id: string }[]).map((item) => item.id),
          (value as { id: string }[]).map((item) => item.id),
        )
      : same(actual[key], value),
  );
const safeMessage = (error: unknown) =>
  error instanceof CloudflareError
    ? error.message
    : "The operation could not complete. Check host connectivity and retry. Confirmed resource IDs have been retained.";

export class CloudflareService {
  readonly deps: Dependencies;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  async dispose() {
    this.closing = true;
    await this.queue;
  }
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new CloudflareError("Cloudflare plugin is reloading. Retry after it finishes."),
      );
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  private async records() {
    return Promise.all(
      (await this.deps.storage.list("share:")).map(async (key) =>
        recordSchema.parse(await this.deps.storage.get(key)),
      ),
    );
  }
  private async save(s: RecordShare) {
    s.updatedAt = new Date().toISOString();
    await this.deps.storage.set(`share:${s.id}`, s);
  }
  private async credentials(s?: Share) {
    const settings = await this.deps.settings();
    const credentials = await this.deps.oauth.credentials();
    if (s && s.accountId !== credentials.accountId)
      fail(
        "This share belongs to a different account. Restore its original account ID and reconnect before managing it.",
      );
    return {
      api: this.deps.api(credentials.token),
      account: credentials.accountId,
      path: settings.cloudflaredPath,
    };
  }
  private async tunnelCredentials(target: TunnelTarget) {
    let credentials;
    try {
      credentials = await this.deps.oauth.credentials();
    } catch {
      throw new TunnelBlocked(
        "connection",
        "Cloudflare authorization is unavailable. Reconnect and reload this tunnel.",
      );
    }
    if (credentials.accountId !== target.accountId || credentials.clientId !== target.clientId)
      throw new TunnelBlocked(
        "connection",
        "The connected account or OAuth client changed. Reload this tunnel.",
      );
    return this.deps.api(credentials.token);
  }
  private async tunnelOwner(target: TunnelTarget) {
    try {
      return (await this.records()).find(
        (record) =>
          record.accountId === target.accountId && record.resources.tunnelId === target.tunnelId,
      );
    } catch {
      throw new TunnelBlocked(
        "ownership",
        "Development share ownership could not be checked. No change was sent.",
      );
    }
  }
  private async writableTunnel(target: TunnelTarget) {
    if (await this.tunnelOwner(target))
      throw new TunnelBlocked(
        "ownership",
        "This tunnel belongs to a development share. Manage it through the share controls.",
      );
    return this.tunnelCredentials(target);
  }
  tunnelDetails(target: TunnelTarget): Promise<TunnelDetails> {
    return this.serialize(() => this.readTunnelDetails(target));
  }
  private async readTunnelDetails(target: TunnelTarget): Promise<TunnelDetails> {
    const api = await this.tunnelCredentials(target);
    const owner = await this.tunnelOwner(target);
    const writeState = await this.reconcileTunnelWrite(target, api);
    const path = `/accounts/${target.accountId}/cfd_tunnel/${target.tunnelId}`;
    const tunnel = await api.request("GET", path, tunnelSchema);
    if (tunnel.id !== target.tunnelId || tunnel.deleted_at)
      throw new CloudflareError("This tunnel is no longer available.");
    const details: TunnelDetails = {
      target,
      writeState,
      name: tunnel.name,
      status: tunnel.status ?? "unknown",
      configSource: tunnel.config_src ?? "unknown",
      owner: owner ? { kind: "share", shareId: owner.id } : { kind: "account" },
      routes: { kind: "unavailable", message: "Routes could not be read." },
      connectors: { kind: "unavailable", message: "Connector details could not be read." },
      observedAt: new Date().toISOString(),
    };
    await Promise.all([
      (async () => {
        if (owner) {
          details.routes = {
            kind: "readonly",
            reason: "share",
            message: "This tunnel belongs to a development share. Use the share controls.",
          };
          return;
        }
        if (tunnel.config_src !== "cloudflare") {
          details.routes = {
            kind: "readonly",
            reason: tunnel.config_src === "local" ? "local" : "unsupported",
            message: "Routes are not managed remotely by Cloudflare.",
          };
          return;
        }
        try {
          details.routes = inspectConfiguration(
            await api.request("GET", `${path}/configurations`, configSchema),
            target,
          );
        } catch {
          details.routes = {
            kind: "unavailable",
            message: "Routes could not be read. Check Cloudflare permissions and refresh.",
          };
        }
      })(),
      (async () => {
        try {
          const connectors = await api.list(`${path}/connections`, connectorResponseSchema);
          details.connectors = {
            kind: "ready",
            value: connectors.map(connectorView),
          };
        } catch {
          details.connectors = {
            kind: "unavailable",
            message:
              "Connector details could not be read. Check Cloudflare permissions and refresh.",
          };
        }
      })(),
    ]);
    if (details.writeState.kind === "unconfirmed" && !owner) {
      try {
        const recovery = await this.tunnelRecoverySnapshot(
          target,
          await this.writableTunnel(target),
        );
        await this.writableTunnel(target);
        details.name = recovery.tunnel.name;
        details.status = recovery.tunnel.status ?? "unknown";
        details.configSource = recovery.tunnel.config_src ?? "unknown";
        if (recovery.configuration)
          details.routes = inspectConfiguration(recovery.configuration, target);
        details.writeState = { ...details.writeState, recovery: { revision: recovery.revision } };
      } catch {}
    }
    await this.tunnelCredentials(target);
    return details;
  }
  editTunnel(input: EditTunnel): Promise<TunnelWriteResult> {
    return this.serialize(async () => {
      try {
        const api = await this.writableTunnel(input);
        if (input.edit.kind === "recover")
          return this.recoverTunnel(input, input.edit.expectedRecoveryRevision, api);
        const writeState = await this.reconcileTunnelWrite(input, api);
        if (writeState.kind === "unconfirmed") return writeState;
        const path = `/accounts/${input.accountId}/cfd_tunnel/${input.tunnelId}`;
        const tunnel = await api.request("GET", path, tunnelSchema);
        if (tunnel.id !== input.tunnelId || tunnel.deleted_at)
          throw new TunnelBlocked("source", "This tunnel is no longer available.");
        const edit = input.edit;
        if (edit.kind === "rename") {
          if (tunnel.name === edit.name)
            return {
              kind: "confirmed",
              changed: false,
              message: "The tunnel already has this name.",
            };
          if (tunnel.name !== edit.expectedName)
            throw new TunnelBlocked(
              "stale",
              "The tunnel name changed. Discard and reload before saving again.",
            );
          return this.writeTunnel(
            input,
            { kind: "rename", fingerprint: configurationFingerprint(edit.name) },
            (currentAPI) => currentAPI.request("PATCH", path, tunnelSchema, { name: edit.name }),
            "Tunnel name saved and verified.",
          );
        }
        if (tunnel.config_src !== "cloudflare")
          throw new TunnelBlocked(
            "source",
            "This tunnel's routes are not managed remotely by Cloudflare.",
          );
        const configPath = `${path}/configurations`;
        const raw = await api.request("GET", configPath, configSchema);
        const routes = inspectConfiguration(raw, input);
        if (routes.kind !== "editable") throw new TunnelBlocked("source", routes.message);
        if (routes.revision !== edit.expectedRevision)
          throw new TunnelBlocked(
            "stale",
            "The tunnel configuration changed. Your draft is retained. Discard and reload before saving again.",
          );
        const config = editableConfiguration(raw)!;
        const desired = applyRouteDraft(config, edit.routes);
        if (sameConfiguration(config, desired))
          return {
            kind: "confirmed",
            changed: false,
            message: "The routes already match this draft.",
          };
        return this.writeTunnel(
          input,
          { kind: "routes", fingerprint: configurationFingerprint(desired) },
          (currentAPI) => currentAPI.request("PUT", configPath, configSchema, { config: desired }),
          "Routes saved and verified. DNS and Access settings are managed separately.",
        );
      } catch (error) {
        return tunnelPreparationFailure(error);
      }
    });
  }
  private async tunnelRecoverySnapshot(target: TunnelTarget, api: CloudflareAPI) {
    const raw = await this.deps.storage.get(tunnelWriteKey(target));
    if (raw === undefined)
      throw new TunnelBlocked(
        "stale",
        "The pending write changed. Refresh status before recovering editing.",
      );
    const fence = tunnelWriteFenceSchema.parse(raw);
    if (fence.target.accountId !== target.accountId || fence.target.tunnelId !== target.tunnelId)
      throw new TunnelBlocked("source", "The pending record does not match this tunnel.");
    const path = `/accounts/${target.accountId}/cfd_tunnel/${target.tunnelId}`;
    const tunnel = await api.request("GET", path, tunnelSchema);
    if (tunnel.id !== target.tunnelId || tunnel.deleted_at)
      throw new TunnelBlocked("source", "This tunnel is no longer available.");
    const localRename = fence.intent.kind === "rename" && tunnel.config_src === "local";
    const configuration = localRename
      ? undefined
      : await api.request("GET", `${path}/configurations`, configSchema);
    if (
      configuration &&
      (!configuration.config || !configuration.source || configuration.source !== tunnel.config_src)
    )
      throw new TunnelBlocked(
        "source",
        "A complete current tunnel configuration is required for recovery.",
      );
    const revision = configurationFingerprint({
      kind: "tunnel-write-recovery",
      target: { accountId: target.accountId, clientId: target.clientId, tunnelId: target.tunnelId },
      fence,
      tunnel: { id: tunnel.id, name: tunnel.name, configSource: tunnel.config_src },
      configuration,
    });
    return { fence, revision, tunnel, configuration };
  }
  private async recoverTunnel(
    target: TunnelTarget,
    expectedRevision: string,
    api: CloudflareAPI,
  ): Promise<TunnelWriteResult> {
    try {
      const snapshot = await this.tunnelRecoverySnapshot(target, api);
      if (snapshot.revision !== expectedRevision)
        throw new TunnelBlocked(
          "stale",
          "The pending write or tunnel configuration changed. Refresh status and review recovery again.",
        );
      await this.writableTunnel(target);
      const current = await this.deps.storage.get(tunnelWriteKey(target));
      if (!sameConfiguration(current, snapshot.fence))
        throw new TunnelBlocked(
          "stale",
          "The pending write changed. Refresh status and review recovery again.",
        );
      await this.deps.storage.delete(tunnelWriteKey(target));
      return {
        kind: "confirmed",
        changed: false,
        message:
          "Editing recovered. The earlier request was not cancelled, undone, or retried and may still apply later. Discard and reload before saving another change.",
      };
    } catch (error) {
      if (error instanceof TunnelBlocked) return tunnelPreparationFailure(error);
      return unavailableTunnelWrite;
    }
  }
  private async reconcileTunnelWrite(
    target: TunnelTarget,
    api: CloudflareAPI,
  ): Promise<TunnelWriteState> {
    let fence: z.infer<typeof tunnelWriteFenceSchema>;
    try {
      const raw = await this.deps.storage.get(tunnelWriteKey(target));
      if (raw === undefined) return { kind: "ready" };
      fence = tunnelWriteFenceSchema.parse(raw);
      if (fence.target.accountId !== target.accountId || fence.target.tunnelId !== target.tunnelId)
        return unavailableTunnelWrite;
    } catch {
      return unavailableTunnelWrite;
    }
    const path = `/accounts/${target.accountId}/cfd_tunnel/${target.tunnelId}`;
    try {
      let matches: boolean;
      if (fence.intent.kind === "rename") {
        const actual = await api.request("GET", path, tunnelSchema);
        matches =
          actual.id === target.tunnelId &&
          !actual.deleted_at &&
          configurationFingerprint(actual.name) === fence.intent.fingerprint;
      } else {
        const actual = await api.request("GET", `${path}/configurations`, configSchema);
        matches =
          actual.source === "cloudflare" &&
          configurationFingerprint(actual.config) === fence.intent.fingerprint;
      }
      if (!matches) return pendingTunnelWrite;
      await this.deps.storage.delete(tunnelWriteKey(target));
      return { kind: "ready" };
    } catch {
      return pendingTunnelWrite;
    }
  }
  private async writeTunnel(
    target: TunnelTarget,
    intent: TunnelWriteIntent,
    write: (api: CloudflareAPI) => Promise<unknown>,
    message: string,
  ): Promise<TunnelWriteResult> {
    try {
      await this.deps.storage.set(tunnelWriteKey(target), {
        operationId: randomUUID(),
        target: {
          accountId: target.accountId,
          clientId: target.clientId,
          tunnelId: target.tunnelId,
        },
        intent,
      });
    } catch {
      return unavailableTunnelWrite;
    }
    let api: CloudflareAPI;
    try {
      api = await this.writableTunnel(target);
    } catch (error) {
      try {
        await this.deps.storage.delete(tunnelWriteKey(target));
      } catch {
        return unavailableTunnelWrite;
      }
      return tunnelPreparationFailure(error);
    }
    try {
      await write(api);
    } catch (error) {
      if (error instanceof CloudflareError && !error.uncertain) {
        try {
          await this.deps.storage.delete(tunnelWriteKey(target));
        } catch {
          return unavailableTunnelWrite;
        }
        return { kind: "rejected", message: error.message };
      }
    }
    const writeState = await this.reconcileTunnelWrite(target, api);
    return writeState.kind === "ready" ? { kind: "confirmed", changed: true, message } : writeState;
  }
  async overview(): Promise<Overview> {
    const oauth = await this.deps.oauth.status();
    const records = await this.records();
    const result: Overview = {
      setup: {
        configured: oauth.configured && oauth.connected,
        accountId: oauth.accountId,
        missing: [
          ...oauth.missing,
          ...(!oauth.connected ? ["Cloudflare OAuth authorization"] : []),
        ],
        permissions,
        oauth,
      },
      shares: records.map((s) => shareSchema.strip().parse(s)),
      hosts: { items: [] },
      zones: { items: [] },
      dnsRecords: { items: [] },
      identityProviders: { items: [] },
      tunnels: { items: [] },
      apps: { items: [] },
      policies: { items: [] },
    };
    const capture = async <T>(target: { items: T[]; error?: string }, read: () => Promise<T[]>) => {
      try {
        target.items = await read();
      } catch (error) {
        target.error = safeMessage(error);
      }
    };
    const hostRead = capture(result.hosts, () => this.deps.hosts());
    if (!result.setup.configured) {
      await hostRead;
      return result;
    }
    let credentials: { token: string; accountId: string };
    try {
      credentials = await this.deps.oauth.credentials();
    } catch (error) {
      result.setup.oauth = { ...(await this.deps.oauth.status()), error: safeMessage(error) };
      result.setup.configured = false;
      result.setup.missing = ["Cloudflare OAuth authorization"];
      await hostRead;
      return result;
    }
    const api = this.deps.api(credentials.token);
    const base = `/accounts/${credentials.accountId}`;
    await Promise.all([
      hostRead,
      capture(result.zones, async () =>
        (await api.list(`/zones?account.id=${credentials.accountId}`, zoneSchema)).map(
          ({ id, name }) => ({ id, name }),
        ),
      ),
      capture(result.identityProviders, () =>
        api.list(`${base}/access/identity_providers`, idpSchema),
      ),
      capture(result.apps, async () =>
        (await api.list(`${base}/access/apps`, appSchema)).map((app) => ({
          id: app.id,
          name: app.name,
          domain: app.domain ?? "",
          type: app.type,
          policyIds: app.policies.map((p) => p.id),
        })),
      ),
      capture(result.policies, async () =>
        (await api.list(`${base}/access/policies`, policySchema)).map((policy) => ({
          id: policy.id,
          name: policy.name,
          decision: policy.decision,
          allowedEmails: policyEmails(policy),
        })),
      ),
      capture(result.tunnels, async () => {
        const tunnels = await api.list(`${base}/cfd_tunnel?is_deleted=false`, tunnelSchema);
        const output: Overview["tunnels"]["items"] = [];
        for (const tunnel of tunnels) {
          const row: Overview["tunnels"]["items"][number] = {
            id: tunnel.id,
            name: tunnel.name,
            status: tunnel.status ?? "unknown",
            configSource: tunnel.config_src ?? "unknown",
            connections: 0,
            dnsTarget: tunnelDNSTarget(tunnel.id),
            publicHostnames: [],
          };
          try {
            row.connections = (
              await api.list(`${base}/cfd_tunnel/${tunnel.id}/connections`, connectionSchema)
            ).reduce((total, client) => total + client.conns.length, 0);
          } catch (error) {
            row.connectionError = safeMessage(error);
          }
          output.push(row);
        }
        return output;
      }),
    ]);
    const network = await readNetworkInventory(
      api,
      credentials.accountId,
      result.zones,
      result.tunnels.items,
    );
    result.dnsRecords = network.dnsRecords;
    result.tunnels.items = network.tunnels;
    await this.observeShares(result);
    return result;
  }
  private async observeShares(result: Overview) {
    for (const share of result.shares) {
      if (share.desiredState === "running" && share.state !== "partial") {
        const tunnel = result.tunnels.items.find((item) => item.id === share.resources.tunnelId);
        try {
          const host = await this.deps.status(share.hostId, share.id);
          share.state = tunnel?.status === "healthy" && host.running ? "running" : "starting";
        } catch {
          share.state = "starting";
        }
      }
    }
  }
  create(input: CreateShare): Promise<ShareResult> {
    return this.serialize(async () => {
      const { account } = await this.credentials();
      const existing = await this.records();
      let s = existing.find((item) => item.id === input.id);
      if (s) {
        if (s.desiredState === "removed")
          fail("This share is being removed or has already been removed.");
        if (
          s.accountId !== account ||
          s.zoneId !== input.zoneId ||
          s.hostname !== input.hostname ||
          s.hostId !== input.hostId ||
          !same(s.desiredSpec, input.spec)
        )
          fail(
            "This share ID already has a different configuration. Use update for its port or email list.",
          );
      } else {
        if (existing.filter((item) => item.state !== "removed").length >= 100)
          fail("The plugin supports up to 100 development shares. Remove unused shares first.");
        if (
          existing.some(
            (item) =>
              item.accountId === account &&
              item.hostname === input.hostname &&
              item.state !== "removed",
          )
        )
          fail("This hostname already belongs to another development share.");
        s = {
          id: input.id,
          accountId: account,
          zoneId: input.zoneId,
          hostname: input.hostname,
          hostId: input.hostId,
          desiredSpec: input.spec,
          desiredState: "running",
          revision: 1,
          resources: {},
          state: "configuring",
          updatedAt: new Date().toISOString(),
        };
        await this.save(s);
      }
      return this.perform(
        s,
        async () => {
          await this.configure(s);
        },
        "Share configured. The connector is starting. Authorized Access login has not been verified.",
      );
    });
  }
  update(id: string, spec: Spec, expectedRevision: number): Promise<ShareResult> {
    return this.mutate(
      id,
      expectedRevision,
      async (s) => {
        if (s.desiredState === "removed") fail("This share is being removed.");
        s.desiredSpec = spec;
        await this.save(s);
        await this.configure(s);
      },
      "Share updated. Access sessions were revoked if emails were removed or the identity provider changed. Existing connections are not forcibly terminated.",
    );
  }
  start(id: string, expectedRevision: number): Promise<ShareResult> {
    return this.mutate(
      id,
      expectedRevision,
      async (s) => {
        if (s.desiredState === "removed") fail("This share is being removed.");
        s.desiredState = "running";
        await this.save(s);
        await this.configure(s);
      },
      "Connector started. Cloudflare health and authorized Access login are separate checks.",
    );
  }
  stop(id: string, expectedRevision: number): Promise<ShareResult> {
    return this.mutate(
      id,
      expectedRevision,
      async (s) => {
        s.desiredState = "stopped";
        await this.save(s);
        const { api } = await this.credentials(s);
        await this.block(s, api);
        await this.stopHost(s);
        await this.deleteDNS(s, api);
        s.state = "stopped";
      },
      "Ingress is blocked and the owned connector has stopped.",
    );
  }
  remove(id: string, expectedRevision: number): Promise<ShareResult> {
    return this.mutate(
      id,
      expectedRevision,
      async (s) => {
        s.desiredState = "removed";
        s.state = "removing";
        await this.save(s);
        const { api } = await this.credentials(s);
        await this.block(s, api);
        await this.stopHost(s);
        await this.deleteDNS(s, api);
        if (s.pendingOperation) await this.resolvePending(s, api);
        if (s.resources.tunnelId) {
          await this.writeConfig(s, api, blocked);
          if (
            (
              await this.allowMissing(() =>
                api.list(
                  `${this.base(s)}/cfd_tunnel/${s.resources.tunnelId}/connections`,
                  connectionSchema,
                ),
              )
            )?.length
          )
            fail(
              "Cloudflare still reports active connectors. Wait for disconnect before removing this share.",
            );
          await this.deleteResource(
            s,
            api,
            "tunnelId",
            `${this.base(s)}/cfd_tunnel/${s.resources.tunnelId}`,
          );
        }
        if (s.resources.appId) {
          await this.allowMissing(() => this.ownedApp(s, api));
          await this.deleteResource(
            s,
            api,
            "appId",
            `${this.base(s)}/access/apps/${s.resources.appId}`,
          );
        }
        if (s.resources.policyId) {
          await this.allowMissing(() => this.ownedPolicy(s, api));
          await this.deleteResource(
            s,
            api,
            "policyId",
            `${this.base(s)}/access/policies/${s.resources.policyId}`,
          );
        }
        s.state = "removed";
      },
      "Owned tunnel, DNS, and Access resources removed.",
      true,
    );
  }
  private mutate(
    id: string,
    expectedRevision: number,
    operation: (s: RecordShare) => Promise<void>,
    message: string,
    allowRemoved = false,
  ) {
    return this.serialize(async () => {
      const raw = await this.deps.storage.get(`share:${id}`);
      if (!raw) fail("Development share not found.");
      const s = recordSchema.parse(raw);
      if (s.desiredState === "removed" && !allowRemoved)
        fail("This share is being removed or has already been removed.");
      if (s.revision !== expectedRevision)
        fail(
          "This share changed since you loaded it. Refresh and retry with its current revision.",
        );
      s.revision++;
      return this.perform(s, () => operation(s), message);
    });
  }
  private async perform(
    s: RecordShare,
    operation: () => Promise<void>,
    message: string,
  ): Promise<ShareResult> {
    try {
      await operation();
      delete s.lastError;
      await this.save(s);
      return { ok: true, share: shareSchema.strip().parse(s), message };
    } catch (error) {
      s.state = "partial";
      s.lastError = safeMessage(error);
      await this.save(s);
      return { ok: false, share: shareSchema.strip().parse(s), message: s.lastError };
    }
  }
  private base(s: Share) {
    return `/accounts/${s.accountId}`;
  }
  private async allowMissing<T>(read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof CloudflareError && error.status === 404) return undefined;
      throw error;
    }
  }
  private async ownedTunnel(s: RecordShare, api: CloudflareAPI) {
    const tunnel = await api.request(
      "GET",
      `${this.base(s)}/cfd_tunnel/${s.resources.tunnelId}`,
      tunnelSchema,
    );
    if (tunnel.name !== name(s) || tunnel.config_src !== "cloudflare")
      fail("Tunnel ownership changed. Refusing to modify it.");
    return tunnel;
  }
  private async ownedApp(s: RecordShare, api: CloudflareAPI) {
    const app = await api.request(
      "GET",
      `${this.base(s)}/access/apps/${s.resources.appId}`,
      appSchema,
    );
    if (
      app.name !== name(s) ||
      app.domain !== s.hostname ||
      app.type !== "self_hosted" ||
      app.policies.length !== 1 ||
      app.policies[0]?.id !== s.resources.policyId ||
      app.self_hosted_domains?.some((domain) => domain !== s.hostname) ||
      app.destinations?.length
    )
      fail("Access application ownership or associations changed. Refusing to modify it.");
    if (
      s.appSnapshot &&
      !same(securityShape(app), s.appSnapshot) &&
      !same(securityShape(app), s.pendingApp)
    )
      fail(
        "Access application changed outside this plugin. Refusing to overwrite its security settings.",
      );
    if (!s.appSnapshot && s.appCreateIntent && !matchesIntent(app, s.appCreateIntent))
      fail(
        "New Access application differs from its saved creation intent. Refusing to overwrite it.",
      );
    return app;
  }
  private async ownedPolicy(s: RecordShare, api: CloudflareAPI) {
    const policy = await api.request(
      "GET",
      `${this.base(s)}/access/policies/${s.resources.policyId}`,
      policySchema,
    );
    if (policy.name !== name(s)) fail("Access policy ownership changed. Refusing to modify it.");
    const apps = await api.list(`${this.base(s)}/access/apps`, appSchema);
    if (
      apps.some(
        (app) =>
          app.id !== s.resources.appId &&
          app.policies.some((policy) => policy.id === s.resources.policyId),
      )
    )
      fail("This policy is attached to another application. Refusing to modify it.");
    if (
      s.policySnapshot &&
      !same(securityShape(policy), s.policySnapshot) &&
      !same(securityShape(policy), s.pendingPolicy)
    )
      fail("Access policy changed outside this plugin. Refusing to overwrite its security rules.");
    if (!s.policySnapshot && s.policyCreateIntent && !matchesIntent(policy, s.policyCreateIntent))
      fail("New Access policy differs from its saved creation intent. Refusing to overwrite it.");
    return policy;
  }
  private async writeConfig(s: RecordShare, api: CloudflareAPI, config: Record<string, unknown>) {
    if (!s.resources.tunnelId) return;
    if (s.desiredState === "removed") {
      if (!(await this.allowMissing(() => this.ownedTunnel(s, api)))) return;
    } else await this.ownedTunnel(s, api);
    const path = `${this.base(s)}/cfd_tunnel/${s.resources.tunnelId}/configurations`;
    const current = (await api.request("GET", path, configSchema)).config ?? {};
    if (!same(current, s.config ?? {}) && !same(current, s.pendingConfig))
      fail(
        "Tunnel ingress changed outside this plugin. Refusing to replace an unrecognized configuration.",
      );
    s.pendingConfig = config;
    await this.save(s);
    await api.request("PUT", path, z.unknown(), { config });
    const readback = (await api.request("GET", path, configSchema)).config;
    if (!same(readback, config))
      fail("Tunnel configuration verification failed. The requested state is not confirmed.");
    s.config = config;
    delete s.pendingConfig;
    await this.save(s);
  }
  private async block(s: RecordShare, api: CloudflareAPI) {
    if (s.pendingOperation === "tunnel") await this.resolvePending(s, api);
    await this.writeConfig(s, api, blocked);
  }
  private async stopHost(s: RecordShare) {
    try {
      const status = await this.deps.stop(s.hostId, s.id);
      if (status.running)
        fail("The host still reports the connector running. Ingress remains blocked.");
    } catch (error) {
      if (error instanceof CloudflareError) throw error;
      fail(
        "Ingress is blocked, but the host is unreachable. Retry when it is online to stop the owned connector.",
      );
    }
  }
  private async deleteResource(
    s: RecordShare,
    api: CloudflareAPI,
    key: keyof Share["resources"],
    path: string,
  ) {
    try {
      await api.request("DELETE", path, z.unknown());
    } catch (error) {
      if (!(error instanceof CloudflareError && error.status === 404)) throw error;
    }
    delete s.resources[key];
    await this.save(s);
  }
  private async deleteDNS(s: RecordShare, api: CloudflareAPI) {
    if (s.pendingOperation === "dns") await this.resolvePending(s, api);
    if (!s.resources.dnsId) return;
    const path = `/zones/${s.zoneId}/dns_records/${s.resources.dnsId}`;
    let record;
    try {
      record = await api.request("GET", path, dnsSchema);
    } catch (error) {
      if (error instanceof CloudflareError && error.status === 404) {
        delete s.resources.dnsId;
        await this.save(s);
        return;
      }
      throw error;
    }
    if (
      record.name !== s.hostname ||
      record.type !== "CNAME" ||
      record.content !== `${s.resources.tunnelId}.cfargotunnel.com` ||
      record.comment !== name(s)
    )
      fail("DNS ownership changed. Refusing to remove this record.");
    await this.deleteResource(s, api, "dnsId", path);
  }
  private async resolvePending(s: RecordShare, api: CloudflareAPI) {
    const kind = s.pendingOperation;
    if (!kind) return;
    const candidates =
      kind === "tunnel"
        ? await api.list(`${this.base(s)}/cfd_tunnel?is_deleted=false`, tunnelSchema)
        : kind === "app"
          ? await api.list(`${this.base(s)}/access/apps`, appSchema)
          : kind === "policy"
            ? await api.list(`${this.base(s)}/access/policies`, policySchema)
            : await api.list(`/zones/${s.zoneId}/dns_records?name=${s.hostname}`, dnsSchema);
    const found = candidates.filter((resource) =>
      kind === "dns"
        ? "comment" in resource && resource.comment === name(s)
        : resource.name === name(s),
    );
    if (found.length !== 1)
      fail(
        `The ${kind} creation has an uncertain result. Its ownership marker is ${name(s)}. Inspect Cloudflare before continuing. No duplicate creation was attempted.`,
      );
    const resource = found[0]!;
    s.resources[`${kind}Id` as keyof Share["resources"]] = resource.id;
    delete s.pendingOperation;
    await this.save(s);
  }
  private async createResource(
    s: RecordShare,
    api: CloudflareAPI,
    kind: NonNullable<Share["pendingOperation"]>,
    path: string,
    body: Record<string, unknown>,
  ) {
    const key = `${kind}Id` as keyof Share["resources"];
    if (s.resources[key]) return;
    if (s.pendingOperation) await this.resolvePending(s, api);
    if (s.resources[key]) return;
    s.pendingOperation = kind;
    if (kind === "policy") s.policyCreateIntent = body;
    if (kind === "app") s.appCreateIntent = body;
    await this.save(s);
    try {
      const resource = await api.request("POST", path, z.object({ id: z.string() }), body);
      s.resources[key] = resource.id;
      delete s.pendingOperation;
      await this.save(s);
    } catch (error) {
      if (error instanceof CloudflareError && !error.uncertain) {
        delete s.pendingOperation;
        await this.save(s);
      }
      throw error;
    }
  }
  private async validate(s: RecordShare, api: CloudflareAPI) {
    const zone = await api.request("GET", `/zones/${s.zoneId}`, zoneSchema);
    if (zone.account.id !== s.accountId || !s.hostname.endsWith(`.${zone.name}`))
      fail("Choose a subdomain in a zone owned by this Cloudflare account.");
    const apps = await api.list(`${this.base(s)}/access/apps`, appSchema);
    if (apps.some((app) => app.id !== s.resources.appId && appOverlaps(app, s.hostname)))
      fail(
        "An existing Access application overlaps this hostname or its paths. Choose another hostname.",
      );
    const dns = await api.list(`/zones/${s.zoneId}/dns_records?name=${s.hostname}`, dnsSchema);
    if (dns.some((record) => record.id !== s.resources.dnsId))
      fail("This hostname already has an unowned DNS record. Choose another hostname.");
    const idps = await api.list(`${this.base(s)}/access/identity_providers`, idpSchema);
    if (!idps.some((idp) => idp.id === s.desiredSpec.identityProviderId))
      fail("Select an existing identity provider in this account.");
    const org = await api.request(
      "GET",
      `${this.base(s)}/access/organizations`,
      z.object({ auth_domain: z.string() }),
    );
    const team = org.auth_domain.match(/^([a-zA-Z0-9-]+)\.cloudflareaccess\.com$/)?.[1];
    if (!team) fail("Configure a Cloudflare Zero Trust team before creating development shares.");
    return team;
  }
  private async configureAccess(s: RecordShare, api: CloudflareAPI): Promise<string> {
    const policyBody = {
      name: name(s),
      decision: "allow",
      include: s.desiredSpec.allowedEmails.map((email) => ({ email: { email } })),
      exclude: [],
      require: [],
    };
    await this.createResource(s, api, "policy", `${this.base(s)}/access/policies`, policyBody);
    const previousPolicy = await this.ownedPolicy(s, api);
    s.pendingPolicy = securityShape({ ...previousPolicy, ...policyBody });
    await this.save(s);
    await api.request(
      "PUT",
      `${this.base(s)}/access/policies/${s.resources.policyId}`,
      z.unknown(),
      { ...previousPolicy, ...policyBody },
    );
    const policy = await this.ownedPolicy(s, api);
    if (
      policy.decision !== "allow" ||
      !same(policy.include, policyBody.include) ||
      policy.exclude.length ||
      policy.require.length
    )
      fail("Access allowlist verification failed. Ingress remains blocked.");
    s.policySnapshot = securityShape(policy);
    delete s.pendingPolicy;
    await this.save(s);
    const appBody = {
      name: name(s),
      type: "self_hosted",
      domain: s.hostname,
      session_duration: "24h",
      app_launcher_visible: false,
      http_only_cookie_attribute: true,
      allowed_idps: [s.desiredSpec.identityProviderId],
      policies: [{ id: s.resources.policyId, precedence: 1 }],
    };
    await this.createResource(s, api, "app", `${this.base(s)}/access/apps`, appBody);
    const previousApp = await this.ownedApp(s, api);
    if (!same(previousApp.allowed_idps, appBody.allowed_idps)) {
      const nextApp = { ...previousApp, allowed_idps: appBody.allowed_idps };
      s.pendingApp = securityShape(nextApp);
      await this.save(s);
      await api.request(
        "PUT",
        `${this.base(s)}/access/apps/${s.resources.appId}`,
        z.unknown(),
        nextApp,
      );
    }
    const app = await this.ownedApp(s, api);
    if (!app.aud || !same(app.allowed_idps, appBody.allowed_idps))
      fail("Access application protection could not be verified. Ingress remains blocked.");
    s.appSnapshot = securityShape(app);
    delete s.pendingApp;
    await this.save(s);
    return app.aud!;
  }
  private async configure(s: RecordShare) {
    const { api, path } = await this.credentials(s);
    if (s.desiredState === "removed") fail("This share is being removed.");
    if (s.pendingOperation) await this.resolvePending(s, api);
    await this.block(s, api);
    const narrowsAccess = Boolean(
      s.appliedSpec &&
      (s.appliedSpec.allowedEmails.some((email) => !s.desiredSpec.allowedEmails.includes(email)) ||
        s.appliedSpec.identityProviderId !== s.desiredSpec.identityProviderId),
    );
    if (narrowsAccess) await this.stopHost(s);
    const team = await this.validate(s, api);
    const hosts = await this.deps.hosts();
    if (!hosts.some((host) => host.id === s.hostId && host.online))
      fail("The selected BB host is offline or no longer enrolled.");
    const probe = await this.deps.probe(s.hostId, s.desiredSpec.port, path);
    if (!probe.available || !probe.originReachable) fail(probe.message);
    await this.createResource(s, api, "tunnel", `${this.base(s)}/cfd_tunnel`, {
      name: name(s),
      config_src: "cloudflare",
    });
    await this.block(s, api);
    const audience = await this.configureAccess(s, api);
    if (narrowsAccess)
      await api.request(
        "POST",
        `${this.base(s)}/access/apps/${s.resources.appId}/revoke_tokens`,
        z.unknown(),
      );
    s.appliedSpec = s.desiredSpec;
    await this.save(s);
    if (s.desiredState === "stopped") {
      await this.stopHost(s);
      await this.deleteDNS(s, api);
      s.state = "stopped";
      return;
    }
    const live = await this.deps.status(s.hostId, s.id);
    const connections = await api.list(
      `${this.base(s)}/cfd_tunnel/${s.resources.tunnelId}/connections`,
      connectionSchema,
    );
    if (
      connections.some(
        (connection) => !live.running || !live.connectorId || connection.id !== live.connectorId,
      )
    )
      fail(
        "Cloudflare reports a connector not owned by this live host worker. Stop that connector before retrying.",
      );
    const config = {
      ingress: [
        {
          hostname: s.hostname,
          service: `http://127.0.0.1:${s.desiredSpec.port}`,
          originRequest: { access: { required: true, teamName: team, audTag: [audience] } },
        },
        { service: "http_status:404" },
      ],
    };
    await this.writeConfig(s, api, config);
    const token = await api.request(
      "GET",
      `${this.base(s)}/cfd_tunnel/${s.resources.tunnelId}/token`,
      z.string(),
    );
    await this.deps.start(s.hostId, s.id, token, path);
    await this.createResource(s, api, "dns", `/zones/${s.zoneId}/dns_records`, {
      type: "CNAME",
      name: s.hostname,
      content: `${s.resources.tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
      comment: name(s),
    });
    const dns = await api.request(
      "GET",
      `/zones/${s.zoneId}/dns_records/${s.resources.dnsId}`,
      dnsSchema,
    );
    if (
      dns.name !== s.hostname ||
      dns.content !== `${s.resources.tunnelId}.cfargotunnel.com` ||
      dns.type !== "CNAME" ||
      !dns.proxied ||
      dns.comment !== name(s)
    )
      fail("DNS publication could not be verified.");
    s.state = "starting";
  }
}

const services = new WeakMap<BbPluginApi, CloudflareService>();
const oauthServices = new WeakMap<BbPluginApi, CloudflareOAuth>();
export function setupService(bb: BbPluginApi) {
  const settings = bb.settings.define({
    oauthClientId: { type: "string", label: "Cloudflare OAuth client ID" },
    oauthRedirectUri: {
      type: "string",
      label: "OAuth callback URL",
      description:
        "Exact HTTPS callback registered with the Cloudflare OAuth client. Ends with /api/v1/plugins/cloudflare/http/oauth/callback.",
    },
    oauthScopes: {
      type: "string",
      label: "OAuth permissions",
      description:
        "Space-separated scope IDs copied from the registered OAuth client. offline_access is added automatically.",
    },
    oauthCredentials: {
      type: "string",
      label: "OAuth authorization (managed automatically)",
      secret: true,
      description: "Saved by Connect Cloudflare. Contains the access and refresh tokens.",
    },
    accountId: { type: "string", label: "Cloudflare account ID" },
    cloudflaredPath: {
      type: "string",
      label: "cloudflared executable",
      default: "cloudflared",
      description: "Executable available on each selected BB host.",
    },
  });
  const oauth = new CloudflareOAuth({
    settings: () => settings.get(),
    save: async (credentials) => {
      await bb.sdk.plugins.updateSettings({
        pluginId: bb.pluginId,
        values: { oauthCredentials: credentials },
      });
    },
  });
  oauthServices.set(bb, oauth);
  bb.http.route(
    "GET",
    "/oauth/callback",
    async (context) => {
      try {
        await oauth.callback(new URL(context.req.url).searchParams);
        return oauthCallbackResponse(true);
      } catch {
        return oauthCallbackResponse(false);
      }
    },
    { auth: "local" },
  );
  const host = bb.hosts.experimental_client({ contract: cloudflareHostContract });
  const service = new CloudflareService({
    storage: bb.storage.kv,
    oauth,
    settings: () => settings.get(),
    api: (token) => new CloudflareAPI(token),
    hosts: async () =>
      (await bb.sdk.hosts.list()).map((item) => ({
        id: item.id,
        name: item.name,
        online: item.status === "connected",
      })),
    probe: (hostId, port, executable) => host.call("probe", { port, executable }, { hostId }),
    status: (hostId, id) => host.call("status", { id }, { hostId }),
    start: (hostId, id, token, executable) =>
      host.call("start", { id, token, executable }, { hostId }),
    stop: (hostId, id) => host.call("stop", { id }, { hostId }),
  });
  services.set(bb, service);
  bb.onDispose(async () => {
    await Promise.all([service.dispose(), oauth.dispose()]);
  });
  return service;
}
export function getService(bb: BbPluginApi) {
  const service = services.get(bb);
  if (!service) throw new Error("Cloudflare service is not initialized.");
  return service;
}

export function getOAuth(bb: BbPluginApi) {
  const oauth = oauthServices.get(bb);
  if (!oauth) throw new Error("Cloudflare OAuth is not initialized.");
  return oauth;
}
