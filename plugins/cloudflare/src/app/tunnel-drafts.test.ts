import { expect, mock, test } from "bun:test";
import type { EditTunnel, TunnelDetails, TunnelWriteResult } from "../shared/schema.ts";
import { TunnelDraftStore, routesDirty } from "./tunnel-drafts.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const target = { accountId: "account", clientId: "client", tunnelId: "tunnel" };
function details(): TunnelDetails {
  return {
    target,
    name: "Preview",
    status: "healthy",
    configSource: "cloudflare",
    owner: { kind: "account" },
    connectors: { kind: "ready", value: [] },
    writeState: { kind: "ready" },
    observedAt: "2026-09-06",
    routes: {
      kind: "editable",
      revision: "a".repeat(64),
      version: 3,
      advanced: true,
      rules: [
        {
          originalIndex: 0,
          hostname: "preview.example.com",
          path: null,
          origin: { kind: "private", label: "Private origin" },
          advanced: true,
        },
      ],
      fallback: { kind: "plain", service: "http_status:404" },
      fallbackAdvanced: false,
    },
  };
}
async function setup() {
  const store = new TunnelDraftStore();
  store.bind(target);
  const live = {
    detail: details(),
    result: { kind: "confirmed", changed: true, message: "Saved" } as TunnelWriteResult,
  };
  const client = {
    tunnelDetails: mock(async () => structuredClone(live.detail)),
    editTunnel: mock(async (_input: EditTunnel) => live.result),
  };
  await store.load(target, client);
  return { store, live, client };
}
function changeRoutes(store: TunnelDraftStore) {
  const routes = store.get(target)!.routes!;
  store.editRoutes(target, [
    {
      ...routes.rows[0]!,
      draft: { kind: "existing", originalIndex: 0, patch: { hostname: "changed.example.com" } },
    },
  ]);
}

test("polling preserves the complete dirty baseline while updating connector observations", async () => {
  const { store, live, client } = await setup();
  store.editName(target, "Draft name");
  changeRoutes(store);
  live.detail.name = "Dashboard name";
  if (live.detail.routes.kind === "editable") live.detail.routes.revision = "b".repeat(64);
  live.detail.connectors = { kind: "unavailable", message: "Unavailable" };
  await store.load(target, client);
  const draft = store.get(target)!;
  expect(draft.name).toEqual({ baseline: "Preview", value: "Draft name" });
  expect(draft.routes!.baseline.revision).toBe("a".repeat(64));
  expect(routesDirty(draft.routes!)).toBe(true);
  expect(draft.detail?.connectors.kind).toBe("unavailable");
});

test("a verified name save preserves an unsaved route draft and only sends a rename", async () => {
  const { store, live, client } = await setup();
  store.editName(target, "Renamed");
  changeRoutes(store);
  live.detail.name = "Renamed";
  await store.save(target, client, "rename");
  expect(client.editTunnel.mock.calls).toEqual([
    [{ ...target, edit: { kind: "rename", expectedName: "Preview", name: "Renamed" } }],
  ]);
  expect(store.get(target)!.name).toEqual({ baseline: "Renamed", value: "Renamed" });
  expect(routesDirty(store.get(target)!.routes!)).toBe(true);
  expect(store.get(target)!.results.routes).toBeUndefined();
});

test("a verified route save replaces its index baseline without losing an unsaved name", async () => {
  const { store, live, client } = await setup();
  store.editName(target, "Draft name");
  changeRoutes(store);
  if (live.detail.routes.kind === "editable") {
    live.detail.routes.revision = "b".repeat(64);
    live.detail.routes.rules[0]!.hostname = "changed.example.com";
  }
  await store.save(target, client, "routes");
  expect(store.get(target)!.name!.value).toBe("Draft name");
  expect(store.get(target)!.routes!.baseline.revision).toBe("b".repeat(64));
  expect(routesDirty(store.get(target)!.routes!)).toBe(false);
  expect(client.editTunnel.mock.calls[0]![0].edit).toEqual({
    kind: "routes",
    expectedRevision: "a".repeat(64),
    routes: [{ kind: "existing", originalIndex: 0, patch: { hostname: "changed.example.com" } }],
  });
});

for (const result of [
  { kind: "unconfirmed", message: "May have applied" },
  { kind: "blocked", reason: "stale", message: "Stale" },
] satisfies TunnelWriteResult[]) {
  test(`${result.kind} keeps the draft and blocks both saves until explicit discard`, async () => {
    const { store, live, client } = await setup();
    changeRoutes(store);
    store.editName(target, "Draft name");
    live.result = result;
    await store.save(target, client, "routes");
    await store.load(target, client);
    await store.save(target, client, "routes");
    await store.save(target, client, "rename");
    expect(client.editTunnel).toHaveBeenCalledTimes(1);
    expect(store.get(target)!.name!.value).toBe("Draft name");
    expect(routesDirty(store.get(target)!.routes!)).toBe(true);
    expect(store.get(target)!.reloadRequired).toBe(true);
    await store.load(target, client, true);
    expect(store.get(target)!.name!.value).toBe("Preview");
    expect(store.get(target)!.reloadRequired).toBe(false);
    expect(routesDirty(store.get(target)!.routes!)).toBe(false);
  });
}

test("a lost save response never retries and a failed discard preserves the draft", async () => {
  const { store, client } = await setup();
  changeRoutes(store);
  client.editTunnel.mockImplementation(async () => {
    throw new Error("transport failed");
  });
  await store.save(target, client, "routes");
  expect(store.get(target)!.results.routes!.kind).toBe("unconfirmed");
  client.tunnelDetails.mockImplementation(async () => {
    throw new Error("read failed");
  });
  await store.load(target, client, true);
  await store.save(target, client, "routes");
  expect(client.editTunnel).toHaveBeenCalledTimes(1);
  expect(routesDirty(store.get(target)!.routes!)).toBe(true);
  expect(store.get(target)!.reloadRequired).toBe(true);
});

test("a definite rejection permits a corrected submission without losing the baseline", async () => {
  const { store, live, client } = await setup();
  store.editName(target, "Rejected");
  live.result = { kind: "rejected", message: "Name rejected" };
  await store.save(target, client, "rename");
  expect(store.get(target)!.reloadRequired).toBe(false);
  store.editName(target, "Fixed");
  await store.save(target, client, "rename");
  expect(client.editTunnel).toHaveBeenCalledTimes(2);
  expect(client.editTunnel.mock.calls[1]![0].edit).toEqual({
    kind: "rename",
    expectedName: "Preview",
    name: "Fixed",
  });
});

test("one pending save locks the aggregate across subscribers and ignores old-binding results", async () => {
  const { store, client } = await setup();
  store.editName(target, "Renamed");
  const pending = deferred<TunnelWriteResult>();
  client.editTunnel.mockImplementation(() => pending.promise);
  const save = store.save(target, client, "rename");
  expect(store.get(target)!.activity).toBe("rename");
  const unsubscribe = store.subscribe(() => {});
  unsubscribe();
  store.subscribe(() => {});
  await store.save(target, client, "rename");
  expect(client.editTunnel).toHaveBeenCalledTimes(1);
  store.bind({ ...target, clientId: "different" });
  store.bind(target);
  await store.load(target, client);
  pending.resolve({ kind: "confirmed", changed: true, message: "Old result" });
  await save;
  expect(store.get(target)!.name!.value).toBe("Preview");
  expect(store.get(target)!.results).toEqual({});
});

test("late reads cannot repopulate a cleared account binding", async () => {
  const store = new TunnelDraftStore();
  store.bind(target);
  const pending = deferred<TunnelDetails>();
  const client = {
    tunnelDetails: mock(() => pending.promise),
    editTunnel: mock(async (): Promise<TunnelWriteResult> => ({
      kind: "rejected",
      message: "unused",
    })),
  };
  const read = store.load(target, client);
  store.bind(null);
  pending.resolve(details());
  await read;
  expect(store.get(target)).toBeUndefined();
});

test("server uncertainty survives explicit reload and preserves both draft baselines", async () => {
  const { store, live, client } = await setup();
  store.editName(target, "Draft name");
  changeRoutes(store);
  live.result = { kind: "unconfirmed", message: "Still pending" };
  await store.save(target, client, "routes");
  expect(store.get(target)!.detail!.writeState.kind).toBe("unconfirmed");
  live.detail.writeState = { kind: "unconfirmed", message: "Still pending" };
  live.detail.name = "External name";
  await store.load(target, client, true);
  expect(store.get(target)!.name).toEqual({ baseline: "Preview", value: "Draft name" });
  expect(routesDirty(store.get(target)!.routes!)).toBe(true);
  expect(store.get(target)!.reloadRequired).toBe(true);
  await store.save(target, client, "routes");
  await store.save(target, client, "rename");
  expect(client.editTunnel).toHaveBeenCalledTimes(1);
  live.detail.writeState = { kind: "ready" };
  await store.load(target, client);
  expect(store.get(target)!.name!.value).toBe("Draft name");
  expect(store.get(target)!.reloadRequired).toBe(true);
  await store.save(target, client, "rename");
  expect(client.editTunnel).toHaveBeenCalledTimes(1);
  await store.load(target, client, true);
  expect(store.get(target)!.reloadRequired).toBe(false);
  expect(store.get(target)!.name!.value).toBe("External name");
});
test("a fresh editor cannot write through another tab's durable pending state", async () => {
  const { live, client } = await setup();
  live.detail.writeState = { kind: "unconfirmed", message: "Another write is pending" };
  const fresh = new TunnelDraftStore();
  fresh.bind(target);
  await fresh.load(target, client);
  fresh.editName(target, "Different name");
  changeRoutes(fresh);
  await fresh.save(target, client, "rename");
  await fresh.save(target, client, "routes");
  expect(client.editTunnel).not.toHaveBeenCalled();
  expect(fresh.get(target)!.reloadRequired).toBe(true);
});
