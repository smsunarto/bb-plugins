import { expect, test } from "bun:test";
import {
  applyRouteDraft,
  configurationRevision,
  editableConfiguration,
  inspectConfiguration,
  validOrigin,
} from "./tunnels.ts";
import { editTunnelSchema, tunnelDetailsSchema } from "../../shared/schema.ts";

const target = { accountId: "account", clientId: "client", tunnelId: "tunnel" };
const raw = () => ({
  source: "cloudflare",
  version: 3,
  config: {
    originRequest: { headers: { Authorization: "ROOT-SECRET" } },
    future: { keep: true },
    ingress: [
      {
        hostname: "Demo.Example.COM",
        path: "^/Raw.*$",
        service: "http://localhost:3000",
        originRequest: { httpHostHeader: "origin.internal" },
        futureRule: 8,
      },
      {
        hostname: "private.example.com",
        service: "http://user:PRIVATE-SECRET@localhost:4000",
        originRequest: { headers: { Token: "RULE-SECRET" } },
      },
      { service: "http_status:404", originRequest: { connectTimeout: 2 }, futureFallback: true },
    ],
  },
});
test("route layout preserves opaque fields, untouched spelling, paths, private origins and immutable fallback", () => {
  const config = editableConfiguration(raw())!;
  const result = applyRouteDraft(config, [
    { kind: "existing", originalIndex: 1, patch: {} },
    { kind: "new", hostname: "new.example.com", path: null, service: "https://localhost:3001" },
    { kind: "existing", originalIndex: 0, patch: { service: "http://localhost:8080" } },
  ]);
  expect(result.originRequest).toEqual(config.originRequest);
  expect(result.future).toEqual(config.future);
  expect(result.ingress[0]).toEqual(config.ingress[1]);
  expect(result.ingress[2]).toEqual({ ...config.ingress[0], service: "http://localhost:8080" });
  expect(result.ingress[3]).toBe(config.ingress[2]!);
  const removed = applyRouteDraft(config, [
    { kind: "existing", originalIndex: 0, patch: { path: null } },
  ]);
  expect(removed.ingress[0]).not.toHaveProperty("path");
  expect(removed.ingress).toHaveLength(2);
});
test("public projection excludes raw config and private service URLs but includes advanced markers", () => {
  const routes = inspectConfiguration(raw(), target);
  expect(routes.kind).toBe("editable");
  if (routes.kind !== "editable") throw new Error("expected editable");
  expect(routes.advanced).toBe(true);
  expect(routes.fallbackAdvanced).toBe(true);
  expect(routes.rules[0]?.advanced).toBe(true);
  expect(routes.rules[1]?.origin.kind).toBe("private");
  expect(JSON.stringify(routes)).not.toContain("SECRET");
  expect(JSON.stringify(routes)).not.toContain("originRequest");
  expect(JSON.stringify(routes)).not.toContain("user:");
  expect(
    tunnelDetailsSchema.safeParse({
      target,
      writeState: { kind: "ready" },
      routes,
      owner: { kind: "account" },
      name: "Demo",
      status: "healthy",
      configSource: "cloudflare",
      observedAt: "now",
      connectors: { kind: "ready", value: [] },
    }).success,
  ).toBe(true);
});
test("revision binds full hidden configuration, source, version, account, client and tunnel", () => {
  const revision = configurationRevision(raw(), target);
  const changed = raw();
  changed.config.originRequest.headers.Authorization = "CHANGED";
  for (const candidate of [changed, { ...raw(), source: "local" }, { ...raw(), version: 4 }])
    expect(configurationRevision(candidate, target)).not.toBe(revision);
  for (const key of ["accountId", "clientId", "tunnelId"] as const)
    expect(configurationRevision(raw(), { ...target, [key]: "other" })).not.toBe(revision);
});
for (const ingress of [
  [],
  [{ service: "http://localhost:3000", hostname: "demo.example.com" }],
  [{ service: "http://localhost:3000", path: "/private" }, { service: "http_status:404" }],
  [{ service: "http_status:404" }, { service: "http_status:404" }],
  [null],
  [{ service: 4 }],
]) {
  test(`unsupported ingress remains readonly: ${JSON.stringify(ingress)}`, () => {
    expect(
      inspectConfiguration({ source: "cloudflare", config: { ingress } }, target),
    ).toMatchObject({ kind: "readonly", reason: "unsupported" });
  });
}
test("layout rejects duplicate, missing and catchall references", () => {
  const config = editableConfiguration(raw())!;
  for (const indices of [[0, 0], [2], [9], [-1], [0.5]])
    expect(() =>
      applyRouteDraft(
        config,
        indices.map((originalIndex) => ({ kind: "existing", originalIndex, patch: {} })),
      ),
    ).toThrow("reference");
});
test("new or replaced route origins reject credentials, unsafe components, and unsupported schemes", () => {
  const config = editableConfiguration(raw())!;
  for (const service of [
    "http://user:SECRET@host",
    "http://host/path",
    "https://host?token=secret",
    "http://host#secret",
    "javascript:alert(1)",
    "http://",
    "http://host\n",
    "unix:/socket?secret",
    "http_status:999",
  ]) {
    expect(validOrigin(service)).toBe(false);
    expect(() =>
      applyRouteDraft(config, [{ kind: "existing", originalIndex: 0, patch: { service } }]),
    ).toThrow("origin");
  }
  for (const service of [
    "http://localhost:8080",
    "https://127.0.0.1:4000",
    "tcp://localhost:2222",
    "ssh://localhost:22",
    "unix:/tmp/service.sock",
    "hello_world",
    "http_status:404",
  ])
    expect(validOrigin(service)).toBe(true);
  expect(() =>
    applyRouteDraft(config, [
      { kind: "new", hostname: "", path: null, service: "http://localhost" },
    ]),
  ).toThrow("hostname");
});
test("RPC discriminant refuses mixed rename and route edits or raw config", () => {
  expect(
    editTunnelSchema.safeParse({
      ...target,
      edit: { kind: "rename", name: "new", expectedName: "old", routes: [] },
    }).success,
  ).toBe(false);
  expect(
    editTunnelSchema.safeParse({
      ...target,
      edit: { kind: "routes", expectedRevision: "a".repeat(64), routes: [], config: {} },
    }).success,
  ).toBe(false);
});

test("surplus command fields cannot alter the target revision identity", () => {
  const command = { ...target, edit: { kind: "rename", name: "New", expectedName: "Old" } };
  expect(configurationRevision(raw(), command)).toBe(configurationRevision(raw(), target));
});
