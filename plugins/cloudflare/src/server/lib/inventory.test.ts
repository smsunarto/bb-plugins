import { expect, mock, test } from "bun:test";
import type { Overview } from "../../shared/schema.ts";
import { CloudflareAPI } from "./api.ts";
import { readNetworkInventory, tunnelDNSTarget } from "./inventory.ts";

type Tunnel = Overview["tunnels"]["items"][number];
const tunnelId = "aabbccdd-1111-4111-8111-111111111111";
const tunnel = (id = tunnelId, configSource = "cloudflare"): Tunnel => ({
  id,
  name: "Development",
  configSource,
  status: "healthy",
  connections: 1,
  dnsTarget: tunnelDNSTarget(id),
  publicHostnames: [],
});
const cname = (name: string, content = tunnelDNSTarget(tunnelId), id = name) => ({
  id,
  name,
  type: "CNAME",
  content,
  proxied: true,
  ttl: 1,
});
const success = (result: unknown, totalPages?: number) =>
  Response.json({
    success: true,
    result,
    ...(totalPages ? { result_info: { total_pages: totalPages } } : {}),
  });
function fixture(serve: (url: URL) => Response | Promise<Response>) {
  const fetcher = mock<typeof fetch>(async (input, options) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(options?.method).toBe("GET");
    expect(options?.redirect).toBe("error");
    return serve(url);
  });
  return { api: new CloudflareAPI("API-SECRET", fetcher), fetcher };
}
const zones = { items: [{ id: "zone", name: "example.com" }] };

test("DNS reads paginate each zone and retain successful records when another zone is denied", async () => {
  const f = fixture((url) => {
    if (url.pathname.endsWith("/zones/denied/dns_records"))
      return Response.json({ errors: [{ message: "PRIVATE-ERROR" }] }, { status: 403 });
    if (url.pathname.endsWith("/zones/zone/dns_records")) {
      const page = url.searchParams.get("page");
      return success([cname(`page${page}.example.com`)], 2);
    }
    if (url.pathname.endsWith("/zones/other/dns_records"))
      return success([
        { id: "txt", name: "other.test", type: "TXT", content: "verification-value", ttl: 300 },
      ]);
    return success({ config: { ingress: [] } });
  });
  const result = await readNetworkInventory(
    f.api,
    "account",
    {
      items: [
        ...zones.items,
        { id: "denied", name: "denied.test" },
        { id: "other", name: "other.test" },
      ],
    },
    [tunnel()],
  );
  expect(result.dnsRecords.items).toHaveLength(3);
  expect(result.dnsRecords.items[0]).toMatchObject({
    zoneId: "zone",
    zoneName: "example.com",
    ttl: 1,
    proxied: true,
    tunnelId,
  });
  expect(result.dnsRecords.items[2]).toMatchObject({
    id: "txt",
    zoneName: "other.test",
    content: "verification-value",
    ttl: 300,
  });
  expect(result.dnsRecords.items[2]).not.toHaveProperty("tunnelId");
  expect(result.dnsRecords.error).toContain("denied.test");
  expect(result.dnsRecords.error).toContain("denied");
  expect(JSON.stringify(result)).not.toContain("PRIVATE-ERROR");
  expect(result.tunnels[0]?.publicHostnames.map((entry) => entry.hostname)).toEqual([
    "page1.example.com",
    "page2.example.com",
  ]);
  const pages = f.fetcher.mock.calls
    .filter(([url]) => String(url).includes("/zones/zone/"))
    .map(([url]) => new URL(String(url)).searchParams.get("page"));
  expect(pages).toEqual(["1", "2"]);
});

test("tunnel association requires an exact normalized CNAME target and combines matching ingress", async () => {
  const target = tunnelDNSTarget(tunnelId);
  const records = [
    cname("DEMO.Example.com.", `${target.toUpperCase()}.`, "exact"),
    cname("suffix.example.com", `${target}.evil.test`, "suffix"),
    cname("prefix.example.com", `prefix-${target}`, "prefix"),
    cname("url.example.com", `https://${target}`, "url"),
    cname("path.example.com", `${target}/`, "path"),
    cname("double-dot.example.com", `${target}..`, "double-dot"),
    { ...cname("txt.example.com", target, "txt"), type: "TXT" },
  ];
  const f = fixture((url) =>
    url.pathname.endsWith("/dns_records")
      ? success(records)
      : success({
          config: { ingress: [{ hostname: "demo.example.com", service: "http://127.0.0.1:3000" }] },
        }),
  );
  const result = await readNetworkInventory(f.api, "account", zones, [
    tunnel(tunnelId.toUpperCase()),
  ]);
  expect(result.dnsRecords.items.filter((record) => record.tunnelId)).toEqual([
    { ...records[0]!, zoneId: "zone", zoneName: "example.com", tunnelId: tunnelId.toUpperCase() },
  ]);
  expect(result.tunnels[0]?.dnsTarget).toBe(target);
  expect(result.tunnels[0]?.publicHostnames).toEqual([
    { hostname: "demo.example.com", url: "https://demo.example.com", source: "dns+ingress" },
  ]);
});

test("ingress-only names show HTTPS root links without leaking origin settings or guessing regex paths", async () => {
  const f = fixture((url) =>
    url.pathname.endsWith("/dns_records")
      ? success([])
      : success({
          config: {
            ingress: [
              {
                hostname: "PORTAL.Example.com.",
                path: "^/private(/.*)?$",
                service: "http://PRIVATE-ORIGIN:3000",
                originRequest: { access: { audTag: ["PRIVATE-AUDIENCE"] } },
              },
              { hostname: "portal.example.com", path: ".*", service: "https://PRIVATE-ORIGIN:443" },
              { service: "http_status:404" },
            ],
            warp_routing: { private: "PRIVATE-CONFIG" },
          },
        }),
  );
  const result = await readNetworkInventory(f.api, "account", zones, [tunnel()]);
  expect(result.dnsRecords.items).toEqual([]);
  expect(result.tunnels[0]?.publicHostnames).toEqual([
    { hostname: "portal.example.com", url: "https://portal.example.com", source: "ingress" },
  ]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE-");
  expect(JSON.stringify(result)).not.toContain("/private");
});

test("wildcards, invalid hostnames, malformed punycode and non-HTTP ingress never get browser URLs", async () => {
  const unsafeNames = [
    "*.example.com",
    "javascript:alert(1)",
    "user@evil.example",
    "evil.example/path",
    "evil.example:443",
    "127.0.0.1",
    "localhost",
    "-bad.example",
    "foo..example",
    "xn--a.com",
    "xn--.com",
    "unicode-☃.example",
    "foo.example\n.evil.test",
    `${"a".repeat(64)}.example`,
  ];
  const ingress = [
    ...unsafeNames.map((hostname) => ({ hostname, service: "http://localhost:3000" })),
    { hostname: "ssh.example.com", service: "ssh://localhost:22" },
    { hostname: "tcp.example.com", service: "tcp://localhost:5432" },
    { hostname: "invalid-origin.example.com", service: "http://" },
  ];
  const f = fixture((url) =>
    url.pathname.endsWith("/dns_records") ? success([]) : success({ config: { ingress } }),
  );
  const result = await readNetworkInventory(f.api, "account", zones, [tunnel()]);
  expect(result.tunnels[0]?.publicHostnames).toHaveLength(ingress.length);
  expect(
    result.tunnels[0]?.publicHostnames.every((entry) => !entry.url && entry.source === "ingress"),
  ).toBe(true);
  expect(result.tunnels[0]?.hostnameError).toBeUndefined();
});

test("DNS names matching non-HTTP exact or wildcard ingress remain text even alongside HTTP rules", async () => {
  const f = fixture((url) =>
    url.pathname.endsWith("/dns_records")
      ? success([
          cname("mixed.example.com"),
          cname("db.internal.example.com"),
          cname("dns-only.example.com"),
        ])
      : success({
          config: {
            ingress: [
              { hostname: "mixed.example.com", service: "http://localhost:3000" },
              { hostname: "mixed.example.com", service: "ssh://localhost:22" },
              { hostname: "*.internal.example.com", service: "tcp://localhost:5432" },
            ],
          },
        }),
  );
  const result = await readNetworkInventory(f.api, "account", zones, [tunnel()]);
  const hosts = result.tunnels[0]!.publicHostnames;
  expect(hosts.find((host) => host.hostname === "mixed.example.com")).toEqual({
    hostname: "mixed.example.com",
    source: "dns+ingress",
  });
  expect(hosts.find((host) => host.hostname === "db.internal.example.com")).toEqual({
    hostname: "db.internal.example.com",
    source: "dns+ingress",
  });
  expect(hosts.find((host) => host.hostname === "dns-only.example.com")).toEqual({
    hostname: "dns-only.example.com",
    url: "https://dns-only.example.com",
    source: "dns",
  });
});

test("denied or malformed remote configurations preserve DNS observations and isolate hostname errors", async () => {
  for (const failure of [
    () => Response.json({ errors: [{ message: "PRIVATE-ERROR" }] }, { status: 403 }),
    () => success({ config: { ingress: [{ hostname: "PRIVATE-ERROR", service: null }] } }),
  ]) {
    const f = fixture((url) =>
      url.pathname.endsWith("/dns_records") ? success([cname("demo.example.com")]) : failure(),
    );
    const result = await readNetworkInventory(f.api, "account", zones, [tunnel()]);
    expect(result.tunnels[0]?.publicHostnames).toEqual([
      { hostname: "demo.example.com", url: "https://demo.example.com", source: "dns" },
    ]);
    expect(result.tunnels[0]?.hostnameError).toBeTruthy();
    expect(result.dnsRecords.error).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("PRIVATE-ERROR");
  }
});

test("locally managed tunnels use observed DNS without requesting remote configuration", async () => {
  const f = fixture(() => success([cname("local.example.com")]));
  const result = await readNetworkInventory(f.api, "account", zones, [tunnel(tunnelId, "local")]);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(result.tunnels[0]?.publicHostnames).toEqual([
    { hostname: "local.example.com", url: "https://local.example.com", source: "dns" },
  ]);
  expect(result.tunnels[0]?.hostnameError).toBeUndefined();
});

test("unset DNS comments may be null without invalidating A, CNAME or TXT inventory", async () => {
  const f = fixture(() =>
    success([
      {
        id: "a",
        name: "origin.example.com",
        type: "A",
        content: "192.0.2.1",
        proxied: false,
        ttl: 300,
        comment: null,
      },
      { ...cname("demo.example.com"), comment: null },
      {
        id: "txt",
        name: "example.com",
        type: "TXT",
        content: "verification-value",
        proxied: false,
        ttl: 300,
        comment: null,
      },
    ]),
  );
  const result = await readNetworkInventory(f.api, "account", zones, [tunnel(tunnelId, "local")]);
  expect(result.dnsRecords.error).toBeUndefined();
  expect(result.dnsRecords.items.map((record) => record.type)).toEqual(["A", "CNAME", "TXT"]);
  expect(result.dnsRecords.items[1]?.tunnelId).toBe(tunnelId);
  expect(result.dnsRecords.items.every((record) => !("comment" in record))).toBe(true);
  expect(result.tunnels[0]?.publicHostnames).toEqual([
    { hostname: "demo.example.com", url: "https://demo.example.com", source: "dns" },
  ]);
});

test("zone discovery failure remains distinct from empty DNS while ingress remains available", async () => {
  const f = fixture(() =>
    success({
      config: { ingress: [{ hostname: "ingress.example.com", service: "http://localhost" }] },
    }),
  );
  const result = await readNetworkInventory(
    f.api,
    "account",
    { items: [], error: "Cloudflare denied zone discovery." },
    [tunnel()],
  );
  expect(result.dnsRecords.error).toContain("Zone discovery");
  expect(result.dnsRecords.items).toEqual([]);
  expect(result.tunnels[0]?.publicHostnames[0]?.source).toBe("ingress");
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test("DNS and configuration reads have bounded concurrency across large inventories", async () => {
  let dnsActive = 0;
  let configActive = 0;
  let peakDNS = 0;
  let peakConfig = 0;
  let peakTotal = 0;
  const f = fixture(async (url) => {
    const dns = url.pathname.endsWith("/dns_records");
    if (dns) dnsActive++;
    else configActive++;
    peakDNS = Math.max(peakDNS, dnsActive);
    peakConfig = Math.max(peakConfig, configActive);
    peakTotal = Math.max(peakTotal, dnsActive + configActive);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (dns) dnsActive--;
    else configActive--;
    return success(dns ? [] : { config: { ingress: [] } });
  });
  await readNetworkInventory(
    f.api,
    "account",
    { items: Array.from({ length: 12 }, (_, id) => ({ id: `zone${id}`, name: `zone${id}.test` })) },
    Array.from({ length: 12 }, (_, id) => tunnel(`tunnel${id}`)),
  );
  expect(f.fetcher).toHaveBeenCalledTimes(24);
  expect(peakDNS).toBe(4);
  expect(peakConfig).toBe(4);
  expect(peakTotal).toBeLessThanOrEqual(8);
});
