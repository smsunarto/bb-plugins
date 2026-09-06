import { expect, test } from "bun:test";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { QuickShareService, type QuickDependencies } from "./quick-shares.ts";

const id = "7c2a8e1e-0d0f-4c8e-9a6b-6a4a0b6f2b11";
const url = "https://brave-otter-quick.trycloudflare.com";
function fixture(overrides: Partial<QuickDependencies> = {}) {
  const records = new Map<string, unknown>();
  const storage: PluginKvStorage = {
    get: async <T>(key: string) => structuredClone(records.get(key)) as T | undefined,
    set: async (key, value) => {
      records.set(key, structuredClone(value));
    },
    delete: async (key) => {
      records.delete(key);
    },
    list: async (prefix) => [...records.keys()].filter((key) => key.startsWith(prefix ?? "")),
  };
  const running = new Map<string, string>();
  const calls: string[] = [];
  const hosts = [
    { id: "mac", name: "Dev Mac", online: true },
    { id: "linux", name: "Lab box", online: false },
  ];
  const deps: QuickDependencies = {
    storage,
    executable: async () => "cloudflared",
    hosts: async () => hosts,
    probe: async (_host, port) => ({
      available: true,
      originReachable: port !== 4000,
      message: "ok",
    }),
    status: async (_host, share) => {
      const live = running.get(share);
      return live ? { running: true, url: live, connectorId: "conn" } : { running: false };
    },
    startQuick: async (host, share, port) => {
      calls.push(`start ${host} ${share} ${port}`);
      running.set(share, url);
      return { running: true, url, connectorId: "conn" };
    },
    stop: async (_host, share) => {
      calls.push(`stop ${share}`);
      running.delete(share);
      return { running: false };
    },
    ...overrides,
  };
  return { service: new QuickShareService(deps), hosts, calls, running, records };
}

test("create picks the only online host, starts cloudflared and returns the public URL", async () => {
  const { service, calls } = fixture();
  const result = await service.create({ id, port: 3000 });
  expect(result.ok).toBe(true);
  expect(result.share).toMatchObject({ id, hostId: "mac", port: 3000, state: "running", url });
  expect(result.share.label).toBe("localhost:3000");
  expect(result.message).toContain(url);
  expect(calls).toEqual([`start mac ${id} 3000`]);
  const list = await service.list();
  expect(list.shares.map((share) => share.state)).toEqual(["running"]);
  expect(list.hosts.items).toHaveLength(2);
});

test("create prefers the calling thread's host and reports an unreachable origin", async () => {
  const { service } = fixture({
    hosts: async () => [
      { id: "mac", name: "Dev Mac", online: true },
      { id: "cloud", name: "Cloud box", online: true },
    ],
    threadHost: async () => "cloud",
  });
  const result = await service.create({ port: 4000, label: "  Storybook " }, "thread");
  expect(result.ok).toBe(true);
  expect(result.share.hostId).toBe("cloud");
  expect(result.share.label).toBe("Storybook");
  expect(result.message).toContain("nothing answered on 127.0.0.1:4000");
});

test("create demands a host when several are online and none is implied", async () => {
  const { service } = fixture({
    hosts: async () => [
      { id: "mac", name: "Dev Mac", online: true },
      { id: "cloud", name: "Cloud box", online: true },
    ],
  });
  await expect(service.create({ port: 3000 })).rejects.toThrow("Choose a host with hostId");
  await expect(service.create({ port: 3000, hostId: "nope" })).rejects.toThrow("not enrolled");
});

test("a failed launch keeps the share so it can be started again", async () => {
  let fail = true;
  const { service } = fixture({
    startQuick: async () => {
      if (fail) throw new Error("cloudflared did not report a trycloudflare.com URL in time.");
      return { running: true, url, connectorId: "conn" };
    },
  });
  const failed = await service.create({ id, port: 3000 });
  expect(failed.ok).toBe(false);
  expect(failed.share.state).toBe("error");
  expect(failed.share.lastError).toContain("did not report");
  expect(failed.share.url).toBeUndefined();
  fail = false;
  const started = await service.start(id);
  expect(started.ok).toBe(true);
  expect(started.share).toMatchObject({ state: "running", url });
  expect(started.share.lastError).toBeUndefined();
});

test("retrying create with the same id reuses the running share instead of starting twice", async () => {
  const { service, calls } = fixture();
  await service.create({ id, port: 3000 });
  const again = await service.create({ id, port: 3000 });
  expect(again.ok).toBe(true);
  expect(again.message).toContain("already live");
  expect(calls).toHaveLength(1);
});

test("stop releases the URL and remove forgets the share", async () => {
  const { service, calls, records } = fixture();
  await service.create({ id, port: 3000 });
  const stopped = await service.stop(id);
  expect(stopped.ok).toBe(true);
  expect(stopped.share.state).toBe("stopped");
  expect(stopped.share.url).toBeUndefined();
  const removed = await service.remove(id);
  expect(removed.ok).toBe(true);
  expect(records.size).toBe(0);
  expect(calls).toEqual([`start mac ${id} 3000`, `stop ${id}`, `stop ${id}`]);
  await expect(service.start(id)).rejects.toThrow("No quick share");
});

test("a share on an offline host lists as stopped without calling the host", async () => {
  const { service, hosts } = fixture();
  await service.create({ id, port: 3000 });
  hosts[0]!.online = false;
  const list = await service.list();
  expect(list.shares[0]).toMatchObject({ state: "stopped" });
  expect(list.shares[0]?.url).toBeUndefined();
});
