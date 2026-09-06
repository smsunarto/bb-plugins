import { afterEach, expect, mock, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import type { EditTunnel, TunnelDetails, TunnelWriteResult } from "../shared/schema.ts";
import { TUNNEL_EDITOR as text } from "./labels.ts";
import { tunnelDrafts } from "./tunnel-drafts.ts";

installDom();
const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { TunnelEditor } = await import("./tunnel-editor.tsx");
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
    writeState: { kind: "ready" },
    observedAt: "2026-09-06T12:00:00Z",
    routes: {
      kind: "editable",
      revision: "a".repeat(64),
      version: 3,
      advanced: true,
      rules: [
        {
          originalIndex: 0,
          hostname: "one.example.com",
          path: null,
          origin: { kind: "private", label: "Private origin" },
          advanced: true,
        },
        {
          originalIndex: 1,
          hostname: "two.example.com",
          path: "/api/.*",
          origin: { kind: "plain", service: "http://localhost:3000" },
          advanced: false,
        },
      ],
      fallback: { kind: "plain", service: "http_status:404" },
      fallbackAdvanced: true,
    },
    connectors: {
      kind: "ready",
      value: [
        {
          id: "connector-1",
          architecture: "arm64",
          version: "2026.9",
          startedAt: "2026-09-06T10:00:00Z",
          configVersion: 2,
          connections: [
            {
              id: "connection-1",
              colo: "SJC",
              openedAt: "2026-09-06T11:00:00Z",
              originIp: "192.0.2.1",
              version: "2026.9",
            },
            {},
          ],
        },
        { connections: [] },
      ],
    },
  };
}
function setup(detail = details()) {
  tunnelDrafts.bind(target);
  const client = {
    tunnelDetails: mock(async () => structuredClone(detail)),
    editTunnel: mock(async (_input: EditTunnel): Promise<TunnelWriteResult> => ({
      kind: "confirmed",
      changed: true,
      message: "Saved",
    })),
  };
  return { client, slot: render(<TunnelEditor target={target} client={client} />) };
}
afterEach(() => {
  cleanup();
  tunnelDrafts.bind(null);
});

test("connector details render metadata, missing values, and observed configuration lag", async () => {
  const { slot } = setup();
  await slot.findByText("connector-1");
  for (const value of [
    "arm64",
    "2026-09-06T10:00:00Z",
    "connection-1",
    "192.0.2.1",
    "2026-09-06T11:00:00Z",
  ])
    expect(slot.getByText(value)).toBeTruthy();
  expect(slot.getAllByText(text.unavailable).length).toBeGreaterThanOrEqual(10);
  expect(slot.getByText(text.configLag)).toBeTruthy();
  expect(slot.getByText(text.noConnections)).toBeTruthy();
});

test("route controls send ordered semantic edits and preserve a private origin and fallback", async () => {
  const { slot, client } = setup();
  await slot.findByLabelText("Route 1 Hostname");
  expect((slot.getByLabelText("Route 1 Origin service") as HTMLInputElement).value).toBe("");
  expect(slot.getAllByText(text.advanced)).toHaveLength(2);
  expect(slot.getByText(text.rootAdvanced)).toBeTruthy();
  expect(slot.getByText(text.publicWarning)).toBeTruthy();
  expect(slot.getByText("http_status:404")).toBeTruthy();
  fireEvent.change(slot.getByLabelText("Route 1 Hostname"), {
    target: { value: "changed.example.com" },
  });
  fireEvent.click(slot.getByRole("button", { name: "Move down route 1" }));
  fireEvent.change(slot.getByLabelText("Route 1 Path (optional)"), { target: { value: "" } });
  fireEvent.click(slot.getByRole("button", { name: text.addRoute }));
  fireEvent.change(slot.getByLabelText("Route 3 Hostname"), {
    target: { value: "new.example.com" },
  });
  fireEvent.change(slot.getByLabelText("Route 3 Origin service"), {
    target: { value: "http://localhost:8080" },
  });
  fireEvent.click(slot.getByRole("button", { name: text.saveRoutes }));
  await waitFor(() => expect(client.editTunnel).toHaveBeenCalledTimes(1));
  expect(client.editTunnel.mock.calls[0]![0]).toEqual({
    ...target,
    edit: {
      kind: "routes",
      expectedRevision: "a".repeat(64),
      routes: [
        { kind: "existing", originalIndex: 1, patch: { path: null } },
        { kind: "existing", originalIndex: 0, patch: { hostname: "changed.example.com" } },
        { kind: "new", hostname: "new.example.com", path: null, service: "http://localhost:8080" },
      ],
    },
  });
  await slot.findByText("Saved");
});

test("draft fields and uncertain results survive remount and disable further writes", async () => {
  const { slot, client } = setup();
  client.editTunnel.mockImplementation(async () => ({
    kind: "unconfirmed",
    message: "The change may have applied.",
  }));
  await slot.findByLabelText(text.name);
  fireEvent.change(slot.getByLabelText(text.name), { target: { value: "Draft name" } });
  fireEvent.change(slot.getByLabelText("Route 1 Hostname"), {
    target: { value: "draft.example.com" },
  });
  fireEvent.click(slot.getByRole("button", { name: text.saveRoutes }));
  await slot.findByText("The change may have applied.");
  slot.unmount();
  const next = render(<TunnelEditor target={target} client={client} />);
  await waitFor(() => expect(tunnelDrafts.get(target)!.activity).toBeNull());
  expect((next.getByLabelText(text.name) as HTMLInputElement).value).toBe("Draft name");
  expect((next.getByLabelText("Route 1 Hostname") as HTMLInputElement).value).toBe(
    "draft.example.com",
  );
  expect((next.getByRole("button", { name: text.saveName }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((next.getByRole("button", { name: text.saveRoutes }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(next.getByRole("button", { name: text.discard }));
  await waitFor(() =>
    expect((next.getByLabelText(text.name) as HTMLInputElement).value).toBe("Preview"),
  );
  expect(next.queryByText("The change may have applied.")).toBeNull();
  expect(client.editTunnel).toHaveBeenCalledTimes(1);
});

for (const reason of ["local", "unsupported", "share"] as const) {
  test(`${reason} routes show a read-only reason while connector failures stay independent`, async () => {
    const detail = details();
    detail.routes = { kind: "readonly", reason, message: "Read-only configuration" };
    detail.connectors = { kind: "unavailable", message: "Connector inventory unavailable" };
    if (reason === "share") detail.owner = { kind: "share", shareId: "share-1" };
    const { slot } = setup(detail);
    await slot.findByText(text.readonly[reason]);
    expect(slot.getByText("Connector inventory unavailable")).toBeTruthy();
    expect(slot.queryByRole("button", { name: text.saveRoutes })).toBeNull();
    fireEvent.change(slot.getByLabelText(text.name), { target: { value: "Changed" } });
    expect((slot.getByRole("button", { name: text.saveName }) as HTMLButtonElement).disabled).toBe(
      reason === "share",
    );
  });
}

test("a pending save stays locked when the editor remounts", async () => {
  const { slot, client } = setup();
  const pending = deferred<TunnelWriteResult>();
  client.editTunnel.mockImplementation(() => pending.promise);
  await slot.findByLabelText(text.name);
  fireEvent.change(slot.getByLabelText(text.name), { target: { value: "Renamed" } });
  fireEvent.click(slot.getByRole("button", { name: text.saveName }));
  slot.unmount();
  const next = render(<TunnelEditor target={target} client={client} />);
  expect((next.getByRole("button", { name: text.savingName }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((next.getByRole("button", { name: text.discard }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => {
    pending.resolve({ kind: "confirmed", changed: true, message: "Saved" });
  });
  expect(client.editTunnel).toHaveBeenCalledTimes(1);
});

test("unconfirmed saves offer status refresh and never discard a draft while the server is pending", async () => {
  const live = details();
  const { slot, client } = setup(live);
  await slot.findByLabelText(text.name);
  fireEvent.change(slot.getByLabelText(text.name), { target: { value: "Draft name" } });
  client.editTunnel.mockImplementation(async () => ({
    kind: "unconfirmed",
    message: "Earlier write pending",
  }));
  fireEvent.click(slot.getByRole("button", { name: text.saveName }));
  await slot.findByRole("button", { name: text.refreshStatus });
  expect(slot.queryByRole("button", { name: text.discard })).toBeNull();
  live.writeState = { kind: "unconfirmed", message: "Earlier write pending" };
  fireEvent.click(slot.getByRole("button", { name: text.refreshStatus }));
  await waitFor(() => expect(tunnelDrafts.get(target)!.activity).toBeNull());
  expect((slot.getByLabelText(text.name) as HTMLInputElement).value).toBe("Draft name");
  expect((slot.getByRole("button", { name: text.saveName }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(slot.queryByRole("button", { name: text.discard })).toBeNull();
  live.writeState = { kind: "ready" };
  live.name = "Applied name";
  fireEvent.click(slot.getByRole("button", { name: text.refreshStatus }));
  await slot.findByRole("button", { name: text.discard });
  expect((slot.getByLabelText(text.name) as HTMLInputElement).value).toBe("Draft name");
  expect((slot.getByRole("button", { name: text.saveName }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(slot.getByRole("button", { name: text.discard }));
  await waitFor(() =>
    expect((slot.getByLabelText(text.name) as HTMLInputElement).value).toBe("Applied name"),
  );
  expect(client.editTunnel).toHaveBeenCalledTimes(1);
});

test("recovery is unavailable without a server recovery snapshot", async () => {
  const live = details();
  live.writeState = { kind: "unconfirmed", message: "Pending without recovery" };
  const { slot, client } = setup(live);
  await slot.findByText("Pending without recovery");
  expect(slot.queryByText(text.recover)).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: text.refreshStatus }));
  await waitFor(() => expect(tunnelDrafts.get(target)!.activity).toBeNull());
  expect(client.editTunnel).not.toHaveBeenCalled();
});

test("recovery acknowledgement resets on a new snapshot and on editor remount", async () => {
  const live = details();
  live.writeState = {
    kind: "unconfirmed",
    message: "Pending",
    recovery: { revision: "c".repeat(64) },
  };
  const { slot, client } = setup(live);
  fireEvent.click(await slot.findByText(text.recover));
  const form = slot.getByRole("form", { name: text.recover });
  fireEvent.submit(form);
  expect(client.editTunnel).not.toHaveBeenCalled();
  expect(
    (slot.getByRole("button", { name: text.confirmRecovery }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(slot.getByRole("checkbox", { name: text.recoveryAcknowledgement }));
  live.writeState.recovery = { revision: "d".repeat(64) };
  fireEvent.click(slot.getByRole("button", { name: text.refreshStatus }));
  await waitFor(() => expect(tunnelDrafts.get(target)!.activity).toBeNull());
  fireEvent.click(slot.getByText(text.recover));
  expect(
    (slot.getByRole("checkbox", { name: text.recoveryAcknowledgement }) as HTMLInputElement)
      .checked,
  ).toBe(false);
  fireEvent.click(slot.getByRole("checkbox", { name: text.recoveryAcknowledgement }));
  slot.unmount();
  const next = render(<TunnelEditor target={target} client={client} />);
  await waitFor(() => expect(tunnelDrafts.get(target)!.activity).toBeNull());
  fireEvent.click(next.getByText(text.recover));
  expect(
    (next.getByRole("checkbox", { name: text.recoveryAcknowledgement }) as HTMLInputElement)
      .checked,
  ).toBe(false);
  expect(client.editTunnel).not.toHaveBeenCalled();
});

test("deliberate recovery sends one acknowledged token and preserves drafts until discard", async () => {
  const live = details();
  const { slot, client } = setup(live);
  await slot.findByLabelText(text.name);
  fireEvent.change(slot.getByLabelText(text.name), { target: { value: "Draft name" } });
  fireEvent.change(slot.getByLabelText("Route 1 Hostname"), {
    target: { value: "draft.example.com" },
  });
  live.writeState = {
    kind: "unconfirmed",
    message: "Pending",
    recovery: { revision: "c".repeat(64) },
  };
  await act(() => tunnelDrafts.load(target, client));
  fireEvent.click(slot.getByText(text.recover));
  expect(slot.getByText(text.recoveryHelp)).toBeTruthy();
  const pending = deferred<TunnelWriteResult>();
  client.editTunnel.mockImplementation(() => pending.promise);
  fireEvent.click(slot.getByRole("checkbox", { name: text.recoveryAcknowledgement }));
  fireEvent.click(slot.getByRole("button", { name: text.confirmRecovery }));
  fireEvent.submit(slot.getByRole("form", { name: text.recover }));
  expect(client.editTunnel.mock.calls).toEqual([
    [
      {
        ...target,
        edit: { kind: "recover", expectedRecoveryRevision: "c".repeat(64), acknowledgeRisk: true },
      },
    ],
  ]);
  expect((slot.getByRole("button", { name: text.recovering }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  live.writeState = { kind: "ready" };
  await act(async () => {
    pending.resolve({ kind: "confirmed", changed: false, message: "Editing lock cleared" });
  });
  expect(slot.getByText("Editing lock cleared")).toBeTruthy();
  expect((slot.getByLabelText(text.name) as HTMLInputElement).value).toBe("Draft name");
  expect((slot.getByLabelText("Route 1 Hostname") as HTMLInputElement).value).toBe(
    "draft.example.com",
  );
  expect((slot.getByRole("button", { name: text.saveName }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((slot.getByRole("button", { name: text.saveRoutes }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(slot.getByRole("button", { name: text.discard }));
  await waitFor(() =>
    expect((slot.getByLabelText(text.name) as HTMLInputElement).value).toBe("Preview"),
  );
  expect(client.editTunnel).toHaveBeenCalledTimes(1);
});
