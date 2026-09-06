import { expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { editTunnelSchema } from "../../shared/schema.ts";
import type { EditTunnel, RouteDraft, Share, TunnelTarget } from "../../shared/schema.ts";
import { CloudflareAPI } from "./api.ts";
import { CloudflareService, type Dependencies } from "./service.ts";

const target: TunnelTarget = { accountId: "account", clientId: "client", tunnelId: "tunnel" };
const path = "/accounts/account/cfd_tunnel/tunnel";
const success = (result: unknown) => Response.json({ success: true, result });
function fixture() {
  const state = {
    tunnel: {
      id: "tunnel",
      name: "Existing",
      config_src: "cloudflare",
      status: "healthy",
      deleted_at: null as string | null,
    },
    config: {
      source: "cloudflare",
      version: 1,
      config: {
        future: { opaque: "ROOT-SECRET" },
        originRequest: { keepAliveTimeout: 12 },
        ingress: [
          {
            hostname: "Demo.Example.COM",
            path: "^/api",
            service: "http://localhost:3000",
            originRequest: { httpHostHeader: "origin.internal" },
          },
          { hostname: "private.example.com", service: "http://user:PRIVATE-SECRET@localhost:3001" },
          { service: "http_status:404", futureFallback: true },
        ],
      } as Record<string, unknown>,
    },
    credentials: { accountId: "account", clientId: "client", token: "OAUTH-SECRET" },
    writeStatus: 200,
    dropWrite: false,
    applyWrite: true,
    invalidWrite: false,
    failVerification: false,
    failConnectors: false,
    failConfigRead: false,
    ownershipError: false,
    wrote: false,
    afterRead: undefined as (() => void) | undefined,
  };
  const records = new Map<string, unknown>();
  const storage: PluginKvStorage = {
    get: async <T>(key: string) => structuredClone(records.get(key)) as T | undefined,
    list: async (prefix) => {
      if (state.ownershipError) throw new Error("STORAGE-SECRET");
      return [...records.keys()].filter((key) => key.startsWith(prefix ?? ""));
    },
    set: async (key, value) => {
      records.set(key, structuredClone(value));
    },
    delete: async (key) => {
      records.delete(key);
    },
  };
  const serveRead = (current: string) => {
    if (current.endsWith("/configurations") && state.failConfigRead)
      return new Response("No remote config", { status: 404 });
    if (current.endsWith("/connections"))
      return state.failConnectors
        ? new Response("CONNECTOR-SECRET", { status: 403 })
        : success([
            {
              id: "connector",
              arch: "arm64",
              version: "2026.9.0",
              run_at: "2026-09-06T10:00:00Z",
              config_version: 1,
              conns: [
                {
                  id: "connection",
                  colo_name: "SJC",
                  opened_at: "2026-09-06T10:00:00Z",
                  origin_ip: "192.0.2.3",
                  client_version: "2026.9.0",
                },
              ],
            },
            {},
          ]);
    if (state.wrote && state.failVerification) throw new Error("READ-SECRET");
    const response = success(current === path ? state.tunnel : state.config);
    state.afterRead?.();
    return response;
  };
  const fetcher = mock<typeof fetch>(async (url, options) => {
    const current = new URL(String(url)).pathname.replace("/client/v4", "");
    const method = options?.method ?? "GET";
    if (![path, `${path}/configurations`, `${path}/connections`].includes(current))
      throw new Error(`Forbidden endpoint ${current}`);
    if (method === "GET") {
      return serveRead(current);
    }
    if (
      !(method === "PATCH" && current === path) &&
      !(method === "PUT" && current.endsWith("/configurations"))
    )
      throw new Error(`Forbidden write ${method} ${current}`);
    state.wrote = true;
    if (state.writeStatus >= 400)
      return new Response("PROVIDER-SECRET", { status: state.writeStatus });
    const body = JSON.parse(String(options?.body));
    if (state.applyWrite) {
      if (method === "PATCH") state.tunnel.name = body.name;
      else {
        state.config.config = body.config;
        state.config.version++;
      }
    }
    if (state.dropWrite) throw new Error("TRANSPORT-SECRET");
    if (state.invalidWrite) return new Response("not-json");
    return success(method === "PATCH" ? state.tunnel : state.config);
  });
  const neverHost = mock(async () => {
    throw new Error("Unexpected host call");
  });
  const deps: Dependencies = {
    storage,
    settings: async () => ({ cloudflaredPath: "cloudflared" }),
    oauth: {
      credentials: async () => ({ ...state.credentials }),
      status: async () => ({
        configured: true,
        connected: true,
        accountId: state.credentials.accountId,
        clientId: state.credentials.clientId,
        redirectUri: "https://bb.example.com",
        missing: [],
      }),
    },
    api: (token) => new CloudflareAPI(token, fetcher),
    hosts: neverHost,
    probe: neverHost,
    status: neverHost,
    start: neverHost,
    stop: neverHost,
  };
  const service = new CloudflareService(deps);
  const writes = () => fetcher.mock.calls.filter(([, options]) => options?.method !== "GET");
  const routeEdit = async (
    routes: RouteDraft[] = [
      { kind: "existing", originalIndex: 0, patch: { service: "http://localhost:8080" } },
      { kind: "existing", originalIndex: 1, patch: {} },
    ],
  ): Promise<EditTunnel> => {
    const details = await service.tunnelDetails(target);
    if (details.routes.kind !== "editable") throw new Error("Expected editable config");
    return {
      ...target,
      edit: { kind: "routes", expectedRevision: details.routes.revision, routes },
    };
  };
  const own = (status: Share["state"] = "partial") => {
    const share: Share = {
      id: randomUUID(),
      accountId: "account",
      zoneId: "zone",
      hostname: "share.example.com",
      hostId: "host",
      desiredSpec: { port: 3000, allowedEmails: ["me@example.com"], identityProviderId: "idp" },
      desiredState: "running",
      revision: 1,
      resources: { tunnelId: "tunnel" },
      state: status,
      updatedAt: "now",
    };
    records.set(`share:${share.id}`, share);
  };
  return { service, state, fetcher, writes, routeEdit, own, records, neverHost, deps };
}
const rename: EditTunnel = {
  ...target,
  edit: { kind: "rename", expectedName: "Existing", name: "Renamed" },
};

function expectJSONValue(value: unknown) {
  expect(value).not.toBeUndefined();
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) expectJSONValue(entry);
  }
}
test("details project connector metadata and redact private configuration without writes", async () => {
  const f = fixture();
  const details = await f.service.tunnelDetails(target);
  expect(details.connectors).toMatchObject({
    kind: "ready",
    value: [
      {
        id: "connector",
        architecture: "arm64",
        configVersion: 1,
        connections: [{ colo: "SJC", originIp: "192.0.2.3" }],
      },
      { connections: [] },
    ],
  });
  expect(details.owner).toEqual({ kind: "account" });
  expectJSONValue(details);
  expect(JSON.stringify(details)).not.toContain("SECRET");
  expect(f.writes()).toHaveLength(0);
  expect(f.neverHost).not.toHaveBeenCalled();
});
test("rename PATCH and route PUT are separate, each verified through one GET", async () => {
  const f = fixture();
  expect(await f.service.editTunnel(rename)).toMatchObject({ kind: "confirmed", changed: true });
  const command = await f.routeEdit();
  expect(await f.service.editTunnel(command)).toMatchObject({ kind: "confirmed", changed: true });
  expect(f.writes().map(([, options]) => options?.method)).toEqual(["PATCH", "PUT"]);
  expect(f.state.config.config).toMatchObject({
    future: { opaque: "ROOT-SECRET" },
    ingress: [
      {
        hostname: "Demo.Example.COM",
        path: "^/api",
        service: "http://localhost:8080",
        originRequest: { httpHostHeader: "origin.internal" },
      },
      { service: "http://user:PRIVATE-SECRET@localhost:3001" },
      { service: "http_status:404", futureFallback: true },
    ],
  });
  expect(f.neverHost).not.toHaveBeenCalled();
});
test("no-op names and layouts issue no write", async () => {
  const f = fixture();
  expect(
    await f.service.editTunnel({
      ...rename,
      edit: { kind: "rename", expectedName: "older", name: "Existing" },
    }),
  ).toMatchObject({ kind: "confirmed", changed: false });
  const command = await f.routeEdit([
    { kind: "existing", originalIndex: 0, patch: {} },
    { kind: "existing", originalIndex: 1, patch: {} },
  ]);
  expect(await f.service.editTunnel(command)).toMatchObject({ kind: "confirmed", changed: false });
  expect(f.writes()).toHaveLength(0);
});
test("share records block generic mutation in every lifecycle state", async () => {
  for (const state of [
    "configuring",
    "starting",
    "running",
    "stopped",
    "partial",
    "removing",
    "removed",
  ] as const) {
    const f = fixture();
    f.own(state);
    expect(await f.service.editTunnel(rename)).toMatchObject({
      kind: "blocked",
      reason: "ownership",
    });
    expect((await f.service.tunnelDetails(target)).routes).toMatchObject({
      kind: "readonly",
      reason: "share",
    });
    expect(f.writes()).toHaveLength(0);
  }
});
test("unreadable or malformed share storage blocks changes", async () => {
  for (const malformed of [false, true]) {
    const f = fixture();
    if (malformed) f.records.set("share:invalid", { resources: { tunnelId: "tunnel" } });
    else f.state.ownershipError = true;
    const result = await f.service.editTunnel(rename);
    expect(result).toMatchObject({ kind: "blocked", reason: "ownership" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(f.writes()).toHaveLength(0);
  }
});
test("account and OAuth client mismatches block reads and writes", async () => {
  for (const key of ["accountId", "clientId"] as const) {
    const f = fixture();
    f.state.credentials[key] = "other";
    expect(await f.service.editTunnel(rename)).toMatchObject({
      kind: "blocked",
      reason: "connection",
    });
    await expect(f.service.tunnelDetails(target)).rejects.toThrow("changed");
    expect(f.fetcher).not.toHaveBeenCalled();
  }
});
test("binding and ownership are checked again after reads immediately before dispatch", async () => {
  for (const change of ["account", "client", "owner"] as const) {
    const f = fixture();
    f.state.afterRead = () => {
      if (change === "owner") f.own();
      else if (change === "client") f.state.credentials.clientId = "other";
      else f.state.credentials.accountId = "other";
    };
    expect(await f.service.editTunnel(rename)).toMatchObject({
      kind: "blocked",
      reason: change === "owner" ? "ownership" : "connection",
    });
    expect(f.writes()).toHaveLength(0);
  }
});
test("local tunnels allow rename but prohibit routes", async () => {
  const f = fixture();
  const command = await f.routeEdit();
  f.state.tunnel.config_src = "local";
  expect((await f.service.tunnelDetails(target)).routes).toMatchObject({
    kind: "readonly",
    reason: "local",
  });
  expect(await f.service.editTunnel(command)).toMatchObject({ kind: "blocked", reason: "source" });
  expect(await f.service.editTunnel(rename)).toMatchObject({ kind: "confirmed" });
  expect(f.writes()).toHaveLength(1);
});
test("stale names, hidden fields, source and deleted tunnels stop before writing", async () => {
  for (const change of ["name", "hidden", "source", "deleted"] as const) {
    const f = fixture();
    const command = change === "name" ? rename : await f.routeEdit();
    if (change === "name") f.state.tunnel.name = "External";
    if (change === "hidden") f.state.config.config.future = { opaque: "different" };
    if (change === "source") f.state.config.source = "local";
    if (change === "deleted") f.state.tunnel.deleted_at = "2026-09-06T00:00:00Z";
    expect(await f.service.editTunnel(command)).toMatchObject({
      kind: "blocked",
      reason: ["name", "hidden"].includes(change) ? "stale" : "source",
    });
    expect(f.writes()).toHaveLength(0);
  }
});
test("a repeated completed route command stops at stale revision without a second PUT", async () => {
  const f = fixture();
  const command = await f.routeEdit();
  expect(await f.service.editTunnel(command)).toMatchObject({ kind: "confirmed" });
  expect(await f.service.editTunnel(command)).toMatchObject({ kind: "blocked", reason: "stale" });
  expect(f.writes()).toHaveLength(1);
});
test("concurrent commands serialize and only the first route draft writes", async () => {
  const f = fixture();
  const command = await f.routeEdit();
  const results = await Promise.all([f.service.editTunnel(command), f.service.editTunnel(command)]);
  expect(results.map((result) => result.kind)).toEqual(["confirmed", "blocked"]);
  expect(f.writes()).toHaveLength(1);
});
for (const status of [403, 429, 503])
  test(`HTTP ${status} write response is classified without retry`, async () => {
    const f = fixture();
    f.state.writeStatus = status;
    expect(await f.service.editTunnel(rename)).toMatchObject({
      kind: status === 503 ? "unconfirmed" : "rejected",
    });
    expect(f.writes()).toHaveLength(1);
    expect(f.fetcher.mock.calls.filter(([, options]) => options?.method === "GET")).toHaveLength(
      status === 503 ? 2 : 1,
    );
  });
for (const kind of ["rename", "routes"] as const)
  for (const failure of ["dropped", "invalid", "readback", "mismatch", "preimage"] as const)
    test(`${kind} ${failure} reconciles once without rollback or retry`, async () => {
      const f = fixture();
      const command = kind === "rename" ? rename : await f.routeEdit();
      f.fetcher.mockClear();
      if (failure === "dropped" || failure === "preimage") f.state.dropWrite = true;
      if (failure === "invalid") f.state.invalidWrite = true;
      if (failure === "readback") f.state.failVerification = true;
      if (failure === "mismatch" || failure === "preimage") f.state.applyWrite = false;
      const result = await f.service.editTunnel(command);
      expect(result).toMatchObject({
        kind: failure === "dropped" || failure === "invalid" ? "confirmed" : "unconfirmed",
      });
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(f.writes()).toHaveLength(1);
      expect(f.fetcher.mock.calls.filter(([, options]) => options?.method === "GET")).toHaveLength(
        kind === "routes" ? 3 : 2,
      );
    });
test("connector failures do not prevent independently verified writes", async () => {
  const f = fixture();
  f.state.failConnectors = true;
  expect((await f.service.tunnelDetails(target)).connectors.kind).toBe("unavailable");
  expect(await f.service.editTunnel(await f.routeEdit())).toMatchObject({ kind: "confirmed" });
  expect(await f.service.editTunnel(rename)).toMatchObject({ kind: "confirmed" });
});
test("invalid route references and origins are rejected before PUT", async () => {
  const f = fixture();
  for (const routes of [
    [{ kind: "existing", originalIndex: 99, patch: {} }],
    [{ kind: "existing", originalIndex: 0, patch: { service: "http://user:secret@localhost" } }],
  ] satisfies RouteDraft[][]) {
    expect(await f.service.editTunnel(await f.routeEdit(routes))).toMatchObject({
      kind: "rejected",
    });
  }
  expect(f.writes()).toHaveLength(0);
});

test("connector projections omit absent and null fields for the BB JSON boundary", async () => {
  const f = fixture();
  f.fetcher.mockImplementationOnce(async () => success(f.state.tunnel));
  f.fetcher.mockImplementationOnce(async () => success(f.state.config));
  f.fetcher.mockImplementationOnce(async () =>
    success([
      {
        id: null,
        arch: null,
        version: null,
        run_at: null,
        config_version: null,
        conns: [{ id: "edge", colo_name: "SJC", origin_ip: null }],
      },
    ]),
  );
  const details = await f.service.tunnelDetails(target);
  expect(details.connectors).toEqual({
    kind: "ready",
    value: [{ connections: [{ id: "edge", colo: "SJC" }] }],
  });
  expectJSONValue(details);
});

test("an uncertain queued route write fences the second draft and survives service restart", async () => {
  const f = fixture();
  const first = await f.routeEdit();
  const second = await f.routeEdit([
    { kind: "existing", originalIndex: 0, patch: { service: "http://localhost:9000" } },
    { kind: "existing", originalIndex: 1, patch: {} },
  ]);
  f.state.dropWrite = true;
  f.state.applyWrite = false;
  const results = await Promise.all([f.service.editTunnel(first), f.service.editTunnel(second)]);
  expect(results.map((result) => result.kind)).toEqual(["unconfirmed", "unconfirmed"]);
  expect(f.writes()).toHaveLength(1);
  const persisted = [...f.records.values()];
  expect(persisted).toHaveLength(1);
  expect(structuredClone(persisted[0])).toMatchObject({
    target,
    intent: { kind: "routes", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
  });
  expect(JSON.stringify(persisted)).not.toContain("SECRET");
  expect(JSON.stringify(persisted)).not.toContain("http://");
  expect(JSON.stringify(persisted)).not.toContain("originRequest");
  const restarted = new CloudflareService(f.deps);
  expect((await restarted.tunnelDetails(target)).writeState.kind).toBe("unconfirmed");
  expect(await restarted.editTunnel(second)).toMatchObject({ kind: "unconfirmed" });
  expect(await restarted.editTunnel(rename)).toMatchObject({ kind: "unconfirmed" });
  expect(f.writes()).toHaveLength(1);
  const sent = JSON.parse(String(f.writes()[0]![1]?.body));
  f.state.config.config = sent.config;
  f.state.config.version++;
  expect((await restarted.tunnelDetails(target)).writeState.kind).toBe("ready");
  expect(f.records.size).toBe(0);
  expect(await restarted.editTunnel(second)).toMatchObject({ kind: "blocked", reason: "stale" });
  expect(f.writes()).toHaveLength(1);
});
test("pending rename blocks even no-op commands and a new OAuth client cannot bypass it", async () => {
  const f = fixture();
  f.state.dropWrite = true;
  f.state.applyWrite = false;
  expect(await f.service.editTunnel(rename)).toMatchObject({ kind: "unconfirmed" });
  expect(JSON.stringify([...f.records.values()])).not.toContain("Renamed");
  f.state.credentials.clientId = "new-client";
  const rebound = { ...target, clientId: "new-client" };
  expect(
    await f.service.editTunnel({
      ...rebound,
      edit: { kind: "rename", name: "Existing", expectedName: "Existing" },
    }),
  ).toMatchObject({ kind: "unconfirmed" });
  expect(f.writes()).toHaveLength(1);
  f.state.tunnel.name = "Renamed";
  expect((await f.service.tunnelDetails(rebound)).writeState.kind).toBe("ready");
  expect(f.records.size).toBe(0);
});
test("definite rejection clears its fence and a corrected command can proceed", async () => {
  const f = fixture();
  f.state.writeStatus = 403;
  expect(await f.service.editTunnel(rename)).toMatchObject({ kind: "rejected" });
  expect(f.records.size).toBe(0);
  f.state.writeStatus = 200;
  expect(await f.service.editTunnel(rename)).toMatchObject({ kind: "confirmed" });
  expect(f.records.size).toBe(0);
});
test("fence persistence and lookup failures fail closed before dispatch", async () => {
  for (const operation of ["get", "set"] as const) {
    const f = fixture();
    f.deps.storage[operation] = mock(async () => {
      throw new Error("STORAGE-SECRET");
    });
    const result = await f.service.editTunnel(rename);
    expect(result).toMatchObject({ kind: "unconfirmed" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(f.writes()).toHaveLength(0);
  }
});
test("fence cleanup failure never claims confirmation or allows another write", async () => {
  for (const rejected of [false, true]) {
    const f = fixture();
    const remove = f.deps.storage.delete;
    f.deps.storage.delete = mock(async () => {
      throw new Error("STORAGE-SECRET");
    });
    if (rejected) f.state.writeStatus = 403;
    expect(await f.service.editTunnel(rename)).toMatchObject({ kind: "unconfirmed" });
    expect(f.records.size).toBe(1);
    expect(await f.service.editTunnel(rename)).toMatchObject({ kind: "unconfirmed" });
    expect(f.writes()).toHaveLength(1);
    if (!rejected) {
      f.deps.storage.delete = remove;
      expect((await f.service.tunnelDetails(target)).writeState.kind).toBe("ready");
      expect(f.records.size).toBe(0);
    }
  }
});
test("binding changes during fence persistence prevent dispatch and clear the unsent intent", async () => {
  const f = fixture();
  const persist = f.deps.storage.set;
  f.deps.storage.set = async (key, value) => {
    await persist(key, value);
    f.state.credentials.clientId = "changed";
  };
  expect(await f.service.editTunnel(rename)).toMatchObject({
    kind: "blocked",
    reason: "connection",
  });
  expect(f.writes()).toHaveLength(0);
  expect(f.records.size).toBe(0);
});
test("malformed durable fence blocks writes instead of being overwritten", async () => {
  const f = fixture();
  f.records.set("tunnel-write:account:tunnel", { unexpected: true });
  expect(await f.service.editTunnel(rename)).toMatchObject({ kind: "unconfirmed" });
  expect(f.writes()).toHaveLength(0);
  expect(f.records.get("tunnel-write:account:tunnel")).toEqual({ unexpected: true });
});

async function pendingRecovery(
  f: ReturnType<typeof fixture>,
  command: EditTunnel = rename,
): Promise<EditTunnel> {
  f.state.dropWrite = true;
  f.state.applyWrite = false;
  expect(await f.service.editTunnel(command)).toMatchObject({ kind: "unconfirmed" });
  const detail = await f.service.tunnelDetails(target);
  if (detail.writeState.kind !== "unconfirmed" || !detail.writeState.recovery)
    throw new Error("Expected recovery offer");
  return {
    ...target,
    edit: {
      kind: "recover",
      expectedRecoveryRevision: detail.writeState.recovery.revision,
      acknowledgeRisk: true,
    },
  };
}
test("manual recovery escapes a dropped write without issuing any Cloudflare mutation", async () => {
  const f = fixture();
  const command = await pendingRecovery(f, await f.routeEdit());
  const before = f.fetcher.mock.calls.length;
  const result = await f.service.editTunnel(command);
  expect(result).toMatchObject({ kind: "confirmed", changed: false });
  expect(result.message).toContain("not cancelled");
  expect(f.records.size).toBe(0);
  expect(f.fetcher.mock.calls.slice(before).every(([, options]) => options?.method === "GET")).toBe(
    true,
  );
  expect(f.writes()).toHaveLength(1);
  expect((await f.service.tunnelDetails(target)).writeState.kind).toBe("ready");
});
test("dashboard changes invalidate recovery and fresh details offer a new token without losing current config", async () => {
  const f = fixture();
  const command = await pendingRecovery(f, await f.routeEdit());
  const snapshot = structuredClone(f.state.config.config);
  f.state.config.config = { ...snapshot, dashboardEdit: true };
  f.state.tunnel.name = "Dashboard name";
  expect(await f.service.editTunnel(command)).toMatchObject({ kind: "blocked", reason: "stale" });
  expect(f.records.size).toBe(1);
  const detail = await f.service.tunnelDetails(target);
  expect(detail.name).toBe("Dashboard name");
  expectJSONValue(detail);
  if (detail.writeState.kind !== "unconfirmed" || !detail.writeState.recovery)
    throw new Error("Expected refreshed recovery offer");
  expect(
    await f.service.editTunnel({
      ...target,
      edit: {
        kind: "recover",
        expectedRecoveryRevision: detail.writeState.recovery.revision,
        acknowledgeRisk: true,
      },
    }),
  ).toMatchObject({ kind: "confirmed" });
  expect(f.state.config.config).toEqual({ ...snapshot, dashboardEdit: true });
  expect(f.state.tunnel.name).toBe("Dashboard name");
  expect(f.writes()).toHaveLength(1);
});
test("a replacement pending operation invalidates an older recovery token even for identical intent", async () => {
  const f = fixture();
  const command = await pendingRecovery(f);
  const key = "tunnel-write:account:tunnel";
  const original = structuredClone(f.records.get(key)) as Record<string, unknown>;
  const replacement = { ...original, operationId: randomUUID() };
  f.records.set(key, replacement);
  expect(await f.service.editTunnel(command)).toMatchObject({ kind: "blocked", reason: "stale" });
  expect(f.records.get(key)).toEqual(replacement);
  expect(f.writes()).toHaveLength(1);
});
test("recovery rechecks the exact pending record immediately before deletion", async () => {
  const f = fixture();
  const command = await pendingRecovery(f);
  const key = "tunnel-write:account:tunnel";
  const original = structuredClone(f.records.get(key)) as Record<string, unknown>;
  const replacement = { ...original, operationId: randomUUID() };
  f.state.afterRead = () => {
    f.records.set(key, replacement);
  };
  expect(await f.service.editTunnel(command)).toMatchObject({ kind: "blocked", reason: "stale" });
  expect(f.records.get(key)).toEqual(replacement);
});
test("recovery is account and client bound and blocked by share ownership", async () => {
  for (const change of ["account", "client", "share", "late-share"] as const) {
    const f = fixture();
    const command = await pendingRecovery(f);
    if (change === "account") f.state.credentials.accountId = "other";
    if (change === "client") f.state.credentials.clientId = "other";
    if (change === "share") f.own();
    if (change === "late-share") f.state.afterRead = () => f.own();
    expect(await f.service.editTunnel(command)).toMatchObject({
      kind: "blocked",
      reason: change.includes("share") ? "ownership" : "connection",
    });
    expect(f.records.has("tunnel-write:account:tunnel")).toBe(true);
    expect(f.writes()).toHaveLength(1);
  }
});
test("recovery fails closed on storage reads and deletion errors", async () => {
  for (const operation of ["get", "delete"] as const) {
    const f = fixture();
    const command = await pendingRecovery(f);
    f.deps.storage[operation] = mock(async () => {
      throw new Error("STORAGE-SECRET");
    });
    const result = await f.service.editTunnel(command);
    expect(result.kind).toBe("unconfirmed");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(f.records.has("tunnel-write:account:tunnel")).toBe(true);
    expect(f.writes()).toHaveLength(1);
  }
});
test("details omit recovery when ownership, pending record, or complete current config is unavailable", async () => {
  for (const unavailable of ["share", "fence", "configuration"] as const) {
    const f = fixture();
    await pendingRecovery(f);
    if (unavailable === "share") f.own();
    if (unavailable === "fence") f.records.set("tunnel-write:account:tunnel", { invalid: true });
    if (unavailable === "configuration")
      f.state.config.config = null as unknown as Record<string, unknown>;
    const detail = await f.service.tunnelDetails(target);
    expect(detail.writeState.kind).toBe("unconfirmed");
    expect(detail.writeState).not.toHaveProperty("recovery");
    expectJSONValue(detail);
  }
});
test("legacy persisted fences without operation ID remain explicitly recoverable", async () => {
  const f = fixture();
  await pendingRecovery(f);
  const key = "tunnel-write:account:tunnel";
  const fence = structuredClone(f.records.get(key)) as Record<string, unknown>;
  delete fence.operationId;
  f.records.set(key, fence);
  const detail = await f.service.tunnelDetails(target);
  if (detail.writeState.kind !== "unconfirmed" || !detail.writeState.recovery)
    throw new Error("Expected legacy recovery offer");
  expect(
    await f.service.editTunnel({
      ...target,
      edit: {
        kind: "recover",
        expectedRecoveryRevision: detail.writeState.recovery.revision,
        acknowledgeRisk: true,
      },
    }),
  ).toMatchObject({ kind: "confirmed", changed: false });
  expect(f.records.size).toBe(0);
});
test("the recovery RPC boundary requires explicit risk acknowledgement", () => {
  const edit = { kind: "recover", expectedRecoveryRevision: "a".repeat(64) };
  expect(editTunnelSchema.safeParse({ ...target, edit }).success).toBe(false);
  expect(
    editTunnelSchema.safeParse({ ...target, edit: { ...edit, acknowledgeRisk: false } }).success,
  ).toBe(false);
  expect(
    editTunnelSchema.safeParse({ ...target, edit: { ...edit, acknowledgeRisk: true } }).success,
  ).toBe(true);
});

test("a locally managed rename can recover from metadata when remote configuration is unavailable", async () => {
  const f = fixture();
  f.state.tunnel.config_src = "local";
  f.state.failConfigRead = true;
  const recovery = await pendingRecovery(f);
  const before = f.fetcher.mock.calls.length;
  expect(await f.service.editTunnel(recovery)).toMatchObject({ kind: "confirmed", changed: false });
  expect(
    f.fetcher.mock.calls
      .slice(before)
      .every(
        ([url, options]) => options?.method === "GET" && !String(url).includes("/configurations"),
      ),
  ).toBe(true);
  expect(f.records.size).toBe(0);
  expect(f.writes()).toHaveLength(1);
});
