import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginKvStorage } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { cloudflareHostContract } from "../../shared/host-contract.ts";
import { quickShareSchema } from "../../shared/schema.ts";
import type { QuickCreate, QuickList, QuickResult, QuickShare } from "../../shared/schema.ts";

const recordSchema = quickShareSchema.omit({ state: true, url: true, connectorId: true });
type QuickRecord = z.infer<typeof recordSchema>;
type Host = { id: string; name: string; online: boolean };
type HostStatus = { running: boolean; connectorId?: string; url?: string };
export interface QuickDependencies {
  storage: PluginKvStorage;
  executable: () => Promise<string>;
  hosts: () => Promise<Host[]>;
  // The host the calling thread runs on, when the caller is a thread and bb knows it.
  threadHost?: (threadId: string) => Promise<string | undefined>;
  probe: (
    hostId: string,
    port: number,
    executable: string,
  ) => Promise<{ available: boolean; originReachable: boolean; message: string }>;
  status: (hostId: string, id: string) => Promise<HostStatus>;
  startQuick: (hostId: string, id: string, port: number, executable: string) => Promise<HostStatus>;
  stop: (hostId: string, id: string) => Promise<HostStatus>;
}
class QuickShareError extends Error {}
const key = (id: string) => `quick:${id}`;
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export class QuickShareService {
  private locks = new Map<string, Promise<unknown>>();
  private deps: QuickDependencies;
  constructor(deps: QuickDependencies) {
    this.deps = deps;
  }

  private locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(id, next);
    void next
      .catch(() => {})
      .finally(() => {
        if (this.locks.get(id) === next) this.locks.delete(id);
      });
    return next;
  }

  private async records(): Promise<QuickRecord[]> {
    const keys = await this.deps.storage.list("quick:");
    const records = await Promise.all(
      keys.map(async (item) => recordSchema.safeParse(await this.deps.storage.get(item))),
    );
    return records
      .flatMap((result) => (result.success ? [result.data] : []))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async record(id: string): Promise<QuickRecord> {
    const parsed = recordSchema.safeParse(await this.deps.storage.get(key(id)));
    if (!parsed.success) throw new QuickShareError(`No quick share with id ${id}.`);
    return parsed.data;
  }

  private async save(record: QuickRecord, patch: Partial<QuickRecord> = {}) {
    const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
    if (patch.lastError === undefined && "lastError" in patch) delete next.lastError;
    await this.deps.storage.set(key(next.id), next);
    return next;
  }

  private async liveStatus(record: QuickRecord, hosts?: Host[]): Promise<HostStatus> {
    const host = (hosts ?? (await this.deps.hosts())).find((item) => item.id === record.hostId);
    if (!host?.online) return { running: false };
    try {
      return await this.deps.status(record.hostId, record.id);
    } catch {
      return { running: false };
    }
  }

  private present(record: QuickRecord, status: HostStatus): QuickShare {
    const running = status.running && Boolean(status.url);
    return {
      ...record,
      state: running ? "running" : record.lastError ? "error" : "stopped",
      ...(running ? { url: status.url } : {}),
      ...(status.connectorId ? { connectorId: status.connectorId } : {}),
    };
  }

  async list(): Promise<QuickList> {
    let hosts: Host[] = [];
    let hostError: string | undefined;
    try {
      hosts = await this.deps.hosts();
    } catch (error) {
      hostError = message(error, "Hosts could not be listed.");
    }
    const records = await this.records();
    const shares = await Promise.all(
      records.map(async (record) => this.present(record, await this.liveStatus(record, hosts))),
    );
    return { hosts: { items: hosts, ...(hostError ? { error: hostError } : {}) }, shares };
  }

  private async resolveHost(hostId: string | undefined, threadId?: string): Promise<Host> {
    const hosts = await this.deps.hosts();
    const online = hosts.filter((host) => host.online);
    const pick = (id: string | undefined) =>
      id ? hosts.find((host) => host.id === id) : undefined;
    let host = pick(hostId);
    if (!host && hostId) throw new QuickShareError(`Host ${hostId} is not enrolled in BB.`);
    if (!host && threadId && this.deps.threadHost)
      host = pick(await this.deps.threadHost(threadId));
    if (!host && online.length === 1) host = online[0];
    if (!host) {
      const names = online.map((item) => `${item.name} (${item.id})`).join(", ");
      throw new QuickShareError(
        online.length
          ? `Choose a host with hostId. Online hosts: ${names}.`
          : "No BB host is online. Bring a host online before creating a share.",
      );
    }
    if (!host.online) throw new QuickShareError(`Host ${host.name} is offline.`);
    return host;
  }

  private async launch(record: QuickRecord): Promise<QuickResult> {
    const executable = await this.deps.executable();
    let originReachable = true;
    try {
      const probe = await this.deps.probe(record.hostId, record.port, executable);
      if (!probe.available) return this.failed(record, probe.message);
      originReachable = probe.originReachable;
    } catch (error) {
      return this.failed(record, message(error, "The host could not be reached."));
    }
    try {
      const status = await this.deps.startQuick(record.hostId, record.id, record.port, executable);
      if (!status.url) return this.failed(record, "cloudflared did not report a public URL.");
      const saved = await this.save(record, { lastError: undefined });
      return {
        ok: true,
        share: this.present(saved, status),
        message: originReachable
          ? `${saved.label} is live at ${status.url}. Anyone with the URL can reach port ${saved.port}.`
          : `${saved.label} is live at ${status.url}, but nothing answered on 127.0.0.1:${saved.port} yet. Requests fail until your app listens there.`,
      };
    } catch (error) {
      return this.failed(record, message(error, "cloudflared could not start the quick tunnel."));
    }
  }

  private async failed(record: QuickRecord, lastError: string): Promise<QuickResult> {
    const saved = await this.save(record, { lastError });
    return { ok: false, share: this.present(saved, { running: false }), message: lastError };
  }

  create(input: QuickCreate, threadId?: string): Promise<QuickResult> {
    const id = input.id ?? randomUUID();
    return this.locked(id, async () => {
      const existing = recordSchema.safeParse(await this.deps.storage.get(key(id)));
      if (existing.success) return this.startRecord(existing.data);
      const host = await this.resolveHost(input.hostId, threadId);
      const now = new Date().toISOString();
      const record = await this.save({
        id,
        hostId: host.id,
        port: input.port,
        label: input.label?.trim() || `localhost:${input.port}`,
        createdAt: now,
        updatedAt: now,
      });
      return this.launch(record);
    });
  }

  private async startRecord(record: QuickRecord): Promise<QuickResult> {
    const status = await this.liveStatus(record);
    if (status.running && status.url) {
      return {
        ok: true,
        share: this.present(record, status),
        message: `${record.label} is already live at ${status.url}.`,
      };
    }
    return this.launch(record);
  }

  start(id: string): Promise<QuickResult> {
    return this.locked(id, async () => this.startRecord(await this.record(id)));
  }

  stop(id: string): Promise<QuickResult> {
    return this.locked(id, async () => {
      const record = await this.record(id);
      try {
        await this.deps.stop(record.hostId, record.id);
      } catch (error) {
        return this.failed(record, message(error, "The host could not stop the tunnel."));
      }
      const saved = await this.save(record, { lastError: undefined });
      return {
        ok: true,
        share: this.present(saved, { running: false }),
        message: `${saved.label} stopped. Its trycloudflare.com URL no longer resolves.`,
      };
    });
  }

  remove(id: string): Promise<QuickResult> {
    return this.locked(id, async () => {
      const record = await this.record(id);
      const host = (await this.deps.hosts()).find((item) => item.id === record.hostId);
      if (host?.online) {
        try {
          await this.deps.stop(record.hostId, record.id);
        } catch (error) {
          return this.failed(record, message(error, "The host could not stop the tunnel."));
        }
      }
      await this.deps.storage.delete(key(id));
      return {
        ok: true,
        share: this.present(record, { running: false }),
        message: `${record.label} removed.`,
      };
    });
  }
}

const services = new WeakMap<BbPluginApi, QuickShareService>();
// The thread's environment names the host its agent runs on, so agent-created
// shares default to the port the agent can actually see.
async function threadHost(bb: BbPluginApi, threadId: string) {
  try {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return undefined;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    return environment.hostId || undefined;
  } catch {
    return undefined;
  }
}
export function setupQuickShares(bb: BbPluginApi, executable: () => Promise<string>) {
  const host = bb.hosts.experimental_client({ contract: cloudflareHostContract });
  const service = new QuickShareService({
    storage: bb.storage.kv,
    executable,
    threadHost: (threadId) => threadHost(bb, threadId),
    hosts: async () =>
      (await bb.sdk.hosts.list()).map((item) => ({
        id: item.id,
        name: item.name,
        online: item.status === "connected",
      })),
    probe: (hostId, port, executable) => host.call("probe", { port, executable }, { hostId }),
    status: (hostId, id) => host.call("status", { id }, { hostId }),
    startQuick: (hostId, id, port, executable) =>
      host.call("startQuick", { id, port, executable }, { hostId }),
    stop: (hostId, id) => host.call("stop", { id }, { hostId }),
  });
  services.set(bb, service);
  return service;
}
export function getQuickShares(bb: BbPluginApi) {
  const service = services.get(bb);
  if (!service) throw new Error("Cloudflare quick shares are not initialized.");
  return service;
}
