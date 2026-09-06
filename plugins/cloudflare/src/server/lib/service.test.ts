import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { CloudflareError, CloudflareAPI } from "./api.ts";
import { CloudflareService, type Dependencies } from "./service.ts";
import type { CreateShare, ShareResult } from "../../shared/schema.ts";

type Resource = Record<string, unknown> & { id: string; name?: string };
function fixture() {
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
  const resources = new Map<string, Resource>();
  const configs = new Map<string, unknown>();
  const calls: { method: string; path: string; body: Record<string, unknown> | undefined }[] = [];
  let running = false;
  let online = true;
  let deny = false;
  let failPost = "";
  let failBeforePost = "";
  let failDelete = "";
  let failRevoke = false;
  let failBlock = false;
  let foreign = false;
  let account = "account";
  let token: string | undefined = "API-SECRET";
  const connectorId = "11111111-1111-4111-8111-111111111111";
  const success = (result: unknown) => Response.json({ success: true, result });
  const metadata: Record<string, unknown> = {
    "/zones/zone": { id: "zone", name: "example.com", account: { id: "account" } },
    "/zones": [{ id: "zone", name: "example.com", account: { id: "account" } }],
    "/accounts/account/access/identity_providers": [
      { id: "idp", name: "Email code", type: "onetimepin" },
    ],
    "/accounts/account/access/organizations": { auth_domain: "team.cloudflareaccess.com" },
  };
  const serveTunnel = (path: string, method: string, body?: Record<string, unknown>) => {
    if (path.endsWith("/connections")) {
      if (!resources.has(path.replace(/\/connections$/, "")))
        return new Response("missing", { status: 404 });
      return success(
        running
          ? [{ id: foreign ? "foreign" : connectorId, conns: [{ client_id: connectorId }] }]
          : [],
      );
    }
    if (method === "PUT") {
      if (
        failBlock &&
        JSON.stringify(body) === '{"config":{"ingress":[{"service":"http_status:404"}]}}'
      )
        return new Response("blocked", { status: 503 });
      configs.set(path, body?.config);
    }
    return success({ config: configs.get(path) ?? null });
  };
  const serveCollection = (
    path: string,
    method: string,
    collection: string,
    body?: Record<string, unknown>,
  ) => {
    if (method === "GET")
      return success(
        [...resources].filter(([key]) => key.startsWith(`${path}/`)).map(([, value]) => value),
      );
    if (failBeforePost === collection) {
      failBeforePost = "";
      throw new TypeError("API-SECRET");
    }
    const id = `${collection}-${resources.size + 1}`;
    const resource: Resource = {
      ...body,
      id,
      ...(collection === "apps" ? { aud: "app-audience" } : {}),
      ...(collection === "cfd_tunnel" ? { status: "healthy" } : {}),
    };
    resources.set(`${path}/${id}`, resource);
    if (failPost === collection) {
      failPost = "";
      throw new TypeError("API-SECRET");
    }
    return success(resource);
  };
  const serveResource = (path: string, method: string, body?: Record<string, unknown>) => {
    const existing = resources.get(path);
    if (method === "DELETE") {
      resources.delete(path);
      if (failDelete && path.includes(`/${failDelete}/`)) {
        failDelete = "";
        throw new TypeError("API-SECRET");
      }
      return existing ? success({ id: existing.id }) : new Response("missing", { status: 404 });
    }
    if (!existing) return new Response("missing", { status: 404 });
    if (method === "PUT") {
      resources.set(path, { ...existing, ...body });
      return success(resources.get(path));
    }
    return success(existing);
  };
  const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace("/client/v4", "");
    const method = options?.method ?? "GET";
    const body = options?.body
      ? (JSON.parse(String(options.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ method, path, body });
    if (deny) return Response.json({ errors: [{ message: "API-SECRET" }] }, { status: 403 });
    if (path in metadata) return success(metadata[path]);
    if (path.endsWith("/token")) return success("CONNECTOR-SECRET");
    if (path.endsWith("/revoke_tokens"))
      return failRevoke ? new Response("private error", { status: 503 }) : success(null);
    if (/\/(connections|configurations)$/.test(path)) return serveTunnel(path, method, body);
    const collection = path.match(/\/(cfd_tunnel|apps|policies|dns_records)$/)?.[1];
    return collection
      ? serveCollection(path, method, collection, body)
      : serveResource(path, method, body);
  }) as typeof fetch;
  const deps: Dependencies = {
    storage,
    settings: async () => ({ accountId: account, cloudflaredPath: "cloudflared" }),
    oauth: {
      status: async () => ({
        configured: true,
        connected: Boolean(token),
        accountId: account,
        clientId: "client",
        redirectUri: "https://bb.example.com/api/v1/plugins/cloudflare/http/oauth/callback",
        missing: [],
      }),
      credentials: async () => {
        if (!token) throw new CloudflareError("Connect Cloudflare again.");
        return { token, accountId: account, clientId: "client" };
      },
    },
    api: (secret) => new CloudflareAPI(secret, fetcher),
    hosts: async () => [{ id: "host", name: "Mac", online }],
    probe: async () => ({ available: true, originReachable: true, message: "ready" }),
    status: async () => ({ running, ...(running ? { connectorId } : {}) }),
    start: async (hostId, id, secret) => {
      expect(hostId).toBe("host");
      expect(id).toBeTruthy();
      expect(secret).toBe("CONNECTOR-SECRET");
      running = true;
      return { running, connectorId };
    },
    stop: async () => {
      if (!online) throw new Error("HOST-SECRET");
      running = false;
      return { running };
    },
  };
  const service = new CloudflareService(deps);
  const input: CreateShare = {
    id: randomUUID(),
    hostname: "demo.example.com",
    hostId: "host",
    zoneId: "zone",
    spec: {
      port: 3000,
      allowedEmails: ["a@example.com", "b@example.com"],
      identityProviderId: "idp",
    },
  };
  return {
    service,
    input,
    resources,
    configs,
    calls,
    records,
    deps,
    set: (values: {
      online?: boolean;
      token?: string | null;
      deny?: boolean;
      failPost?: string;
      failBeforePost?: string;
      failDelete?: string;
      failRevoke?: boolean;
      failBlock?: boolean;
      foreign?: boolean;
      account?: string;
    }) => {
      online = values.online ?? online;
      token = values.token === null ? undefined : (values.token ?? token);
      deny = values.deny ?? deny;
      failPost = values.failPost ?? failPost;
      failBeforePost = values.failBeforePost ?? failBeforePost;
      failDelete = values.failDelete ?? failDelete;
      failRevoke = values.failRevoke ?? failRevoke;
      failBlock = values.failBlock ?? failBlock;
      foreign = values.foreign ?? foreign;
      account = values.account ?? account;
    },
  };
}
const assertBlocked = (f: ReturnType<typeof fixture>) =>
  expect([...f.configs.values()]).toEqual([{ ingress: [{ service: "http_status:404" }] }]);
async function create(f: ReturnType<typeof fixture>): Promise<ShareResult> {
  const result = await f.service.create(f.input);
  expect(result.ok).toBe(true);
  return result;
}

test("setup and denied inventory are distinct and never expose credentials", async () => {
  const f = fixture();
  f.set({ token: null });
  const empty = await f.service.overview();
  expect(empty.setup.configured).toBe(false);
  expect(empty.setup.missing).toEqual(["Cloudflare OAuth authorization"]);
  f.set({ token: "API-SECRET", deny: true });
  const denied = await f.service.overview();
  expect(denied.setup.configured).toBe(true);
  expect(denied.tunnels.error).toContain("denied");
  expect(JSON.stringify(denied)).not.toContain("API-SECRET");
});
test("Access readback precedes loopback ingress and DNS, with no private output", async () => {
  const f = fixture();
  const result = await create(f);
  const allowIndex = f.calls.findIndex(
    (call) => call.method === "PUT" && JSON.stringify(call.body).includes("127.0.0.1"),
  );
  const dnsIndex = f.calls.findIndex(
    (call) => call.method === "POST" && call.path.endsWith("/dns_records"),
  );
  expect(allowIndex).toBeGreaterThan(
    f.calls.findIndex((call) => call.method === "GET" && call.path.includes("/access/apps/apps-")),
  );
  expect(dnsIndex).toBeGreaterThan(allowIndex);
  expect(JSON.stringify(f.calls[allowIndex]?.body)).toContain('"required":true');
  expect(result.share.state).toBe("starting");
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(result.share).not.toHaveProperty("config");
  const overview = await f.service.overview();
  expect(overview.shares[0]?.state).toBe("running");
  expect(overview.tunnels.items[0]?.connections).toBe(1);
  expect(overview.shares[0]).not.toHaveProperty("appSnapshot");
});
for (const kind of ["cfd_tunnel", "policies", "apps", "dns_records"]) {
  test(`lost ${kind} POST response recovers IDs across service restart without duplication`, async () => {
    const f = fixture();
    f.set({ failPost: kind });
    const partial = await f.service.create(f.input);
    expect(partial.ok).toBe(false);
    expect(partial.share.pendingOperation).toBeTruthy();
    const resumed = await new CloudflareService(f.deps).create(f.input);
    expect(resumed.ok).toBe(true);
    expect(
      f.calls.filter((call) => call.method === "POST" && call.path.endsWith(`/${kind}`)),
    ).toHaveLength(1);
    expect(f.resources.size).toBe(4);
  });
}
for (const kind of ["policies", "apps"]) {
  test(`bootstrap ${kind} drift after lost create response cannot be overwritten`, async () => {
    const f = fixture();
    f.set({ failPost: kind });
    const initial = await f.service.create(f.input);
    expect(initial.ok).toBe(false);
    const resource = [...f.resources.values()].find((item) => item.id.startsWith(kind))!;
    if (kind === "policies") resource.require = [{ group: { id: "mfa" } }];
    else resource.allowed_idps = ["foreign-idp"];
    const before = f.calls.length;
    const retry = await f.service.create(f.input);
    expect(retry.ok).toBe(false);
    expect(retry.message).toContain("creation intent");
    assertBlocked(f);
    expect(
      f.calls
        .slice(before)
        .some((call) => call.method === "PUT" && call.path.includes(`/${kind}/`)),
    ).toBe(false);
  });
}
test("narrowing Access stops owned child before changing its allowlist", async () => {
  const f = fixture();
  const initial = await create(f);
  f.set({ online: false });
  const before = f.calls.length;
  const result = await f.service.update(
    f.input.id,
    { ...f.input.spec, allowedEmails: ["a@example.com"] },
    initial.share.revision,
  );
  expect(result.ok).toBe(false);
  expect(result.message).toContain("host is unreachable");
  assertBlocked(f);
  expect(
    f.calls.slice(before).some((call) => call.method === "PUT" && call.path.includes("/policies/")),
  ).toBe(false);
});
test("unresolved ambiguous creation never retries POST", async () => {
  const f = fixture();
  f.set({ failBeforePost: "cfd_tunnel" });
  expect((await f.service.create(f.input)).ok).toBe(false);
  const retry = await f.service.create(f.input);
  expect(retry.message).toContain("uncertain");
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
});
test("repeat create uses stable resources and detects the live owned connector", async () => {
  const f = fixture();
  const initial = await create(f);
  const repeated = await f.service.create(f.input);
  expect(repeated.ok).toBe(true);
  expect(repeated.share.resources).toEqual(initial.share.resources);
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(4);
});
test("email removal revokes sessions with no body and remains blocked on failure", async () => {
  const f = fixture();
  const initial = await create(f);
  f.set({ failRevoke: true });
  const changed = { ...f.input.spec, allowedEmails: ["a@example.com"] };
  const result = await f.service.update(f.input.id, changed, initial.share.revision);
  expect(result.ok).toBe(false);
  assertBlocked(f);
  expect(result.share.appliedSpec?.allowedEmails).toHaveLength(2);
  expect(f.calls.find((call) => call.path.endsWith("/revoke_tokens"))?.body).toBeUndefined();
  f.set({ failRevoke: false });
  const retry = await f.service.update(f.input.id, changed, result.share.revision);
  expect(retry.ok).toBe(true);
  expect(retry.share.appliedSpec?.allowedEmails).toEqual(["a@example.com"]);
});
test("foreign policy restrictions are not removed by port edits", async () => {
  const f = fixture();
  const initial = await create(f);
  const policy = [...f.resources.values()].find(
    (item) => item.id === initial.share.resources.policyId,
  )!;
  policy.require = [{ group: { id: "MFA-group" } }];
  const before = f.calls.length;
  const updated = await f.service.update(
    f.input.id,
    { ...f.input.spec, port: 4000 },
    initial.share.revision,
  );
  expect(updated.ok).toBe(false);
  expect(updated.message).toContain("changed outside");
  assertBlocked(f);
  expect(
    f.calls
      .slice(before)
      .filter((call) => call.method === "PUT" && call.path.includes("/policies/")),
  ).toHaveLength(0);
  expect(policy.require).toEqual([{ group: { id: "MFA-group" } }]);
});
test("foreign application settings are preserved and block mutation", async () => {
  const f = fixture();
  const initial = await create(f);
  const app = [...f.resources.values()].find((item) => item.id === initial.share.resources.appId)!;
  app.session_duration = "1h";
  const changed = await f.service.update(
    f.input.id,
    { ...f.input.spec, port: 4000 },
    initial.share.revision,
  );
  expect(changed.ok).toBe(false);
  expect(changed.message).toContain("application changed");
  assertBlocked(f);
});
test("Access wildcard and path conflicts prevent resource creation", async () => {
  for (const domain of ["*.example.com/private", "*emo.example.com", "demo.example.com/admin"]) {
    const f = fixture();
    f.resources.set("/accounts/account/access/apps/foreign", {
      id: "foreign",
      name: "Production",
      type: "self_hosted",
      domain,
    });
    const result = await f.service.create(f.input);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("overlaps");
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  }
});
test("DNS collisions are refused without adoption", async () => {
  const f = fixture();
  f.resources.set("/zones/zone/dns_records/foreign", {
    id: "foreign",
    type: "A",
    name: "demo.example.com",
    content: "192.0.2.1",
  });
  const result = await f.service.create(f.input);
  expect(result.message).toContain("unowned DNS");
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
});
test("stale concurrent revisions cannot overwrite the first update", async () => {
  const f = fixture();
  const initial = await create(f);
  const results = await Promise.allSettled([
    f.service.update(f.input.id, { ...f.input.spec, port: 4000 }, initial.share.revision),
    f.service.stop(f.input.id, initial.share.revision),
  ]);
  expect(results[0]?.status).toBe("fulfilled");
  expect(results[1]?.status).toBe("rejected");
});
test("offline host stop blocks ingress, retains Access, and reports partial", async () => {
  const f = fixture();
  const initial = await create(f);
  f.set({ online: false });
  const stopped = await f.service.stop(f.input.id, initial.share.revision);
  expect(stopped.ok).toBe(false);
  expect(stopped.share.state).toBe("partial");
  assertBlocked(f);
  expect(stopped.share.resources.appId).toBeTruthy();
  expect(stopped.message).not.toContain("SECRET");
});
test("foreign connector blocks start without disconnecting it", async () => {
  const f = fixture();
  const initial = await create(f);
  f.set({ foreign: true });
  const result = await f.service.start(f.input.id, initial.share.revision);
  expect(result.ok).toBe(false);
  expect(result.message).toContain("not owned");
  assertBlocked(f);
  expect(
    f.calls.some((call) => call.method === "DELETE" && call.path.endsWith("/connections")),
  ).toBe(false);
});
test("unconfirmed block forbids removal", async () => {
  const f = fixture();
  const initial = await create(f);
  f.set({ failBlock: true });
  const result = await f.service.remove(f.input.id, initial.share.revision);
  expect(result.ok).toBe(false);
  expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  expect(result.share.resources.appId).toBeTruthy();
});
for (const kind of ["cfd_tunnel", "apps", "policies", "dns_records"]) {
  test(`lost ${kind} DELETE response can resume cleanup`, async () => {
    const f = fixture();
    const initial = await create(f);
    f.set({ failDelete: kind });
    const partial = await f.service.remove(f.input.id, initial.share.revision);
    expect(partial.ok).toBe(false);
    const removed = await new CloudflareService(f.deps).remove(f.input.id, partial.share.revision);
    expect(removed.ok).toBe(true);
    expect(removed.share.state).toBe("removed");
    expect(f.resources.size).toBe(0);
  });
}
test("removed shares cannot be resurrected through stop, start or create", async () => {
  const f = fixture();
  const initial = await create(f);
  const removed = await f.service.remove(f.input.id, initial.share.revision);
  expect(removed.ok).toBe(true);
  await expect(f.service.stop(f.input.id, removed.share.revision)).rejects.toThrow("removed");
  await expect(f.service.start(f.input.id, removed.share.revision)).rejects.toThrow("removed");
  await expect(f.service.create(f.input)).rejects.toThrow("removed");
});
test("account settings cannot repoint an existing share", async () => {
  const f = fixture();
  const initial = await create(f);
  f.set({ account: "other" });
  const stopped = await f.service.stop(f.input.id, initial.share.revision);
  expect(stopped.ok).toBe(false);
  expect(stopped.message).toContain("different account");
  expect(f.calls.some((call) => call.path.startsWith("/accounts/other"))).toBe(false);
});

test("overview exposes observed DNS and safe tunnel links without writing or returning raw configuration", async () => {
  const f = fixture();
  const created = await create(f);
  const before = f.calls.length;
  const overview = await f.service.overview();
  expect(overview.dnsRecords.items).toEqual([
    {
      id: created.share.resources.dnsId!,
      zoneId: "zone",
      zoneName: "example.com",
      name: f.input.hostname,
      type: "CNAME",
      content: `${created.share.resources.tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
      tunnelId: created.share.resources.tunnelId!,
    },
  ]);
  expect(overview.tunnels.items[0]?.publicHostnames).toEqual([
    { hostname: f.input.hostname, url: `https://${f.input.hostname}`, source: "dns+ingress" },
  ]);
  expect(overview.tunnels.items[0]?.dnsTarget).toBe(
    `${created.share.resources.tunnelId}.cfargotunnel.com`,
  );
  expect(f.calls.slice(before).every((call) => call.method === "GET")).toBe(true);
  expect(JSON.stringify(overview)).not.toContain("originRequest");
});
